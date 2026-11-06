/**
 * Session, OAuth2 and authorization helpers.
 *
 * Security model:
 *  - OAuth2 authorization-code flow with a signed `state` cookie.
 *  - Sessions: 256-bit opaque token, only its SHA-256 hash is stored; cookie is
 *    HttpOnly, SameSite=Lax and Secure in production.
 *  - Discord access/refresh tokens are encrypted at rest with AES-256-GCM and
 *    never leave the server.
 *  - Every guild-scoped request re-checks the user's Discord permissions
 *    (cached for a short window and refreshed on demand).
 *  - Dashboard role mapping supports configured admin roles in addition to
 *    Discord's Manage Server permission.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  type AccessLevel,
  type SessionUser,
  canEditModule,
  hasAccess,
  resolveAccessLevel,
} from '@irh/shared';
import {
  decryptSecret,
  encryptSecret,
  hashToken,
  newSessionToken,
  prisma,
  recordAudit,
  getModuleSettings,
} from '@irh/db';
import { env, oauthConfigured } from './env.js';
import { discordApi, DiscordApiError } from './discord.js';

export const SESSION_COOKIE = 'irh_session';
export const CSRF_COOKIE = 'irh_csrf';
export const STATE_COOKIE = 'irh_oauth_state';
const SESSION_TTL_MS = 7 * 86_400_000;
const GUILD_CACHE_TTL_MS = 300_000;

export interface CachedGuild {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: string;
}

export interface AuthContext {
  user: SessionUser;
  sessionId: string;
  csrfToken: string;
  cachedGuilds: CachedGuild[];
}

export interface GuildContext {
  id: string;
  discordId: string;
  name: string;
  icon: string | null;
  botPresent: boolean;
  accessLevel: AccessLevel;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
    guild?: GuildContext;
  }
}

function sign(value: string): string {
  return createHmac('sha256', env.sessionSecret).update(value).digest('base64url');
}

export function createStateToken(): string {
  const nonce = randomBytes(16).toString('base64url');
  const payload = `${nonce}.${sign(nonce)}`;
  return payload;
}

export function verifyStateToken(state: string | undefined): boolean {
  if (!state) return false;
  const [nonce, signature] = state.split('.');
  if (!nonce || !signature) return false;
  const expected = sign(nonce);
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function buildAuthorizeUrl(state: string): string | null {
  if (!oauthConfigured) return null;
  const params = new URLSearchParams({
    client_id: env.discord.clientId,
    redirect_uri: env.discord.redirectUri,
    response_type: 'code',
    scope: 'identify guilds',
    state,
    prompt: 'none',
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export function cookieOptions(maxAgeMs: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: env.isProduction,
    path: '/',
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}

export function setSessionCookie(reply: FastifyReply, token: string, csrf: string) {
  reply.setCookie(SESSION_COOKIE, token, cookieOptions(SESSION_TTL_MS));
  reply.setCookie(CSRF_COOKIE, csrf, { ...cookieOptions(SESSION_TTL_MS), httpOnly: false });
}

export function clearSessionCookies(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  reply.clearCookie(CSRF_COOKIE, { path: '/' });
}

export interface CreateSessionInput {
  user: { id: string; username: string; global_name?: string | null; avatar: string | null; email?: string | null };
  accessToken: string;
  refreshToken: string;
  scopes: string;
  guilds: CachedGuild[];
  ip?: string | null;
  userAgent?: string | null;
}

export async function createSession(input: CreateSessionInput): Promise<{ token: string; csrfToken: string; sessionId: string; user: SessionUser }> {
  const token = newSessionToken();
  const csrfToken = newSessionToken();
  const user = await prisma.user.upsert({
    where: { discordId: input.user.id },
    create: {
      discordId: input.user.id,
      username: input.user.username,
      globalName: input.user.global_name ?? null,
      avatar: input.user.avatar,
      email: input.user.email ?? null,
    },
    update: {
      username: input.user.username,
      globalName: input.user.global_name ?? null,
      avatar: input.user.avatar,
      email: input.user.email ?? null,
    },
  });

  const session = await prisma.session.create({
    data: {
      tokenHash: hashToken(token),
      userId: user.id,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      ip: input.ip ?? null,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
      accessToken: encryptSecret(input.accessToken),
      refreshToken: encryptSecret(input.refreshToken),
      scopes: input.scopes,
      guildsCache: input.guilds as unknown as never,
      guildsCachedAt: new Date(),
    },
  });

  return { token, csrfToken, sessionId: session.id, user: toSessionUser(user) };
}

export function toSessionUser(user: {
  id: string;
  discordId: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
  email: string | null;
}): SessionUser {
  return {
    id: user.id,
    discordId: user.discordId,
    username: user.username,
    globalName: user.globalName,
    avatar: user.avatar,
    email: user.email,
  };
}

export async function loadSession(request: FastifyRequest): Promise<AuthContext | null> {
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const session = await prisma.session.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  const csrfToken = request.cookies?.[CSRF_COOKIE];
  return {
    user: toSessionUser(session.user),
    sessionId: session.id,
    csrfToken: typeof csrfToken === 'string' ? csrfToken : '',
    cachedGuilds: (session.guildsCache as unknown as CachedGuild[]) ?? [],
  };
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = await loadSession(request);
  if (!auth) {
    reply.code(401).send({ error: 'unauthorized', message: 'Sign in with Discord to continue.' });
    return;
  }
  request.auth = auth;
}

/** Refresh the cached guild list from Discord (called on demand, max once/5min). */
export async function refreshGuildCache(sessionId: string): Promise<CachedGuild[]> {
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) return [];
  if (session.guildsCache && session.guildsCachedAt && Date.now() - session.guildsCachedAt.getTime() < GUILD_CACHE_TTL_MS) {
    return session.guildsCache as unknown as CachedGuild[];
  }
  if (!session.accessToken) return (session.guildsCache as unknown as CachedGuild[]) ?? [];
  try {
    const accessToken = decryptSecret(session.accessToken);
    const guilds = await discordApi.userGuilds(accessToken);
    const cached: CachedGuild[] = guilds.map((guild) => ({
      id: guild.id,
      name: guild.name,
      icon: guild.icon,
      owner: guild.owner,
      permissions: guild.permissions,
    }));
    await prisma.session.update({ where: { id: sessionId }, data: { guildsCache: cached as unknown as never, guildsCachedAt: new Date() } });
    return cached;
  } catch (error) {
    const status = error instanceof DiscordApiError ? error.status : 0;
    if (status === 401 && session.refreshToken) {
      try {
        const refreshed = await discordApi.refreshToken(decryptSecret(session.refreshToken));
        await prisma.session.update({
          where: { id: session.id },
          data: { accessToken: encryptSecret(refreshed.access_token), refreshToken: encryptSecret(refreshed.refresh_token) },
        });
        const guilds = await discordApi.userGuilds(refreshed.access_token);
        const cached: CachedGuild[] = guilds.map((guild) => ({
          id: guild.id,
          name: guild.name,
          icon: guild.icon,
          owner: guild.owner,
          permissions: guild.permissions,
        }));
        await prisma.session.update({ where: { id: session.id }, data: { guildsCache: cached as unknown as never, guildsCachedAt: new Date() } });
        return cached;
      } catch {
        return (session.guildsCache as unknown as CachedGuild[]) ?? [];
      }
    }
    return (session.guildsCache as unknown as CachedGuild[]) ?? [];
  }
}

/**
 * Resolve dashboard access for one guild:
 *  1. bot owner / guild owner       -> owner
 *  2. ADMINISTRATOR                 -> admin
 *  3. MANAGE_GUILD                  -> manage_guild
 *  4. configured admin role         -> admin
 *  5. otherwise                     -> null (no access)
 */
export async function resolveGuildAccess(input: {
  userId: string;
  userGuilds: CachedGuild[];
  guildId: string;
  guildOwnerId?: string | null;
}): Promise<AccessLevel | null> {
  if (env.botOwnerIds.includes(input.userId)) return 'owner';
  const cached = input.userGuilds.find((guild) => guild.id === input.guildId);
  if (!cached) return null;
  if (cached.owner) return 'owner';

  const base = resolveAccessLevel({
    userId: input.userId,
    guildOwnerId: input.guildOwnerId ?? null,
    permissions: cached.permissions,
  });
  if (base) return base;

  // Fall back to configured dashboard admin roles (requires the bot to be present).
  try {
    const internal = await prisma.guild.findUnique({ where: { discordId: input.guildId }, select: { id: true } });
    if (!internal) return null;
    const general = await getModuleSettings<{ adminRoleIds: string[] }>(internal.id, 'general');
    if (!general.adminRoleIds?.length) return null;
    const member = await discordApi.guildMember(input.guildId, input.userId);
    if (member.roles.some((roleId) => general.adminRoleIds.includes(roleId))) return 'admin';
    return null;
  } catch {
    return null;
  }
}

export async function resolveGuild(request: FastifyRequest, reply: FastifyReply, discordGuildId: string): Promise<GuildContext | null> {
  if (!request.auth) {
    reply.code(401).send({ error: 'unauthorized', message: 'Authentication required.' });
    return null;
  }
  if (!/^\d{15,25}$/.test(discordGuildId)) {
    reply.code(400).send({ error: 'invalid_guild', message: 'Invalid guild id.' });
    return null;
  }

  const internal = await prisma.guild.findUnique({ where: { discordId: discordGuildId } });
  const accessLevel = await resolveGuildAccess({
    userId: request.auth.user.discordId,
    userGuilds: request.auth.cachedGuilds,
    guildId: discordGuildId,
    guildOwnerId: internal?.ownerId ?? null,
  });

  if (!accessLevel) {
    reply.code(403).send({ error: 'forbidden', message: 'You cannot manage this server.' });
    return null;
  }

  let guildName = internal?.name ?? 'Unknown server';
  let icon = internal?.icon ?? null;
  let ownerId = internal?.ownerId ?? null;
  let botPresent = Boolean(internal && internal.botJoinedAt.getTime() > 0);

  if (!internal || !botPresent) {
    try {
      const live = await discordApi.guild(discordGuildId);
      guildName = live.name;
      icon = live.icon;
      ownerId = live.owner_id;
      botPresent = true;
      await prisma.guild.upsert({
        where: { discordId: discordGuildId },
        create: { discordId: discordGuildId, name: live.name, icon: live.icon, ownerId: live.owner_id },
        update: { name: live.name, icon: live.icon, ownerId: live.owner_id, botJoinedAt: new Date() },
      });
    } catch {
      botPresent = false;
    }
  }

  const record = await prisma.guild.upsert({
    where: { discordId: discordGuildId },
    create: { discordId: discordGuildId, name: guildName, icon, ownerId, memberCount: 0 },
    update: { name: guildName, icon, ownerId },
  });

  const context: GuildContext = {
    id: record.id,
    discordId: discordGuildId,
    name: guildName,
    icon,
    botPresent,
    accessLevel,
  };
  request.guild = context;
  return context;
}

/** preHandler factory: require a minimum access level plus module edit rights. */
export function requireGuild(moduleId?: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    await requireAuth(request, reply);
    if (!request.auth) return;
    const params = request.params as { guildId?: string };
    const guild = await resolveGuild(request, reply, params.guildId ?? '');
    if (!guild) return;
    if (moduleId && !canEditModule(guild.accessLevel, moduleId)) {
      reply.code(403).send({ error: 'forbidden', message: 'Your role cannot change this module.' });
    }
  };
}

/** Same-origin + double-submit CSRF check for every mutating request. */
export async function csrfGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const origin = request.headers.origin;
  if (origin && origin !== env.appOrigin) {
    reply.code(403).send({ error: 'csrf', message: 'Cross-origin request rejected.' });
    return;
  }
  const header = request.headers['x-irh-csrf'];
  const cookie = request.cookies?.[CSRF_COOKIE];
  if (cookie && typeof header === 'string' && header !== cookie) {
    reply.code(403).send({ error: 'csrf', message: 'Invalid CSRF token.' });
  }
}

export async function destroySession(request: FastifyRequest): Promise<void> {
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token) return;
  await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

export async function pruneExpiredSessions(): Promise<void> {
  await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
}

export function hasGuildAccess(level: AccessLevel, required: AccessLevel): boolean {
  return hasAccess(level, required);
}

export async function recordLogin(user: SessionUser, ip?: string, userAgent?: string) {
  await recordAudit({ actorId: user.discordId, action: 'auth.login', targetType: 'user', targetId: user.discordId, ip, userAgent });
}

export const guildIdParamsSchema = z.object({ guildId: z.string().regex(/^\d{15,25}$/) });
