/** OAuth2 authentication routes. */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { logger } from '@irh/db';
import {
  STATE_COOKIE,
  buildAuthorizeUrl,
  clearSessionCookies,
  cookieOptions,
  createSession,
  createStateToken,
  destroySession,
  recordLogin,
  refreshGuildCache,
  requireAuth,
  setSessionCookie,
  verifyStateToken,
} from '../auth.js';
import { discordApi, DiscordApiError, inviteUrl } from '../discord.js';
import { env, oauthConfigured } from '../env.js';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get('/auth/login', async (request, reply) => {
    const state = createStateToken();
    reply.setCookie(STATE_COOKIE, state, cookieOptions(600_000));
    const url = buildAuthorizeUrl(state);
    if (!url) {
      return reply.code(503).send({
        error: 'oauth_not_configured',
        message: 'DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET must be configured before signing in.',
      });
    }
    return reply.redirect(url);
  });

  app.get('/auth/callback', async (request, reply) => {
    if (!oauthConfigured) {
      return reply.code(503).send({ error: 'oauth_not_configured', message: 'Discord OAuth2 is not configured.' });
    }
    const query = z
      .object({ code: z.string().min(1).optional(), state: z.string().optional(), error: z.string().optional() })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_request', message: 'Malformed OAuth2 callback.' });
    if (query.data.error) {
      return reply.redirect(`${env.appOrigin}/?auth=denied`);
    }
    if (!verifyStateToken(query.data.state)) {
      return reply.code(400).send({ error: 'invalid_state', message: 'OAuth2 state verification failed. Please try again.' });
    }
    if (!query.data.code) return reply.code(400).send({ error: 'missing_code', message: 'Missing authorization code.' });

    try {
      const tokens = await discordApi.exchangeCode(query.data.code);
      const [user, guilds] = await Promise.all([discordApi.currentUser(tokens.access_token), discordApi.userGuilds(tokens.access_token)]);
      const cached = guilds.map((guild) => ({
        id: guild.id,
        name: guild.name,
        icon: guild.icon,
        owner: guild.owner,
        permissions: guild.permissions,
      }));
      const session = await createSession({
        user,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        scopes: tokens.scope,
        guilds: cached,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      setSessionCookie(reply, session.token, session.csrfToken);
      reply.clearCookie(STATE_COOKIE, { path: '/' });
      await recordLogin(session.user, request.ip, request.headers['user-agent'] ?? undefined);
      logger.info('auth', 'User signed in', { userId: session.user.discordId, guilds: cached.length });
      return reply.redirect(`${env.appOrigin}/dashboard`);
    } catch (error) {
      const status = error instanceof DiscordApiError ? error.status : 500;
      logger.error('auth', 'OAuth2 callback failed', { status, error });
      return reply.code(502).send({ error: 'oauth_failed', message: 'Discord rejected the sign-in attempt. Please try again.' });
    }
  });

  app.post('/auth/logout', async (request, reply) => {
    await destroySession(request);
    clearSessionCookies(reply);
    return { ok: true };
  });

  app.get('/auth/config', async () => ({
    oauthConfigured,
    botInviteUrl: inviteUrl(),
    clientId: env.discord.clientId || null,
  }));

  app.get('/me', { preHandler: requireAuth }, async (request, reply) => {
    if (!request.auth) return reply.code(401).send({ error: 'unauthorized', message: 'Not signed in.' });
    const guilds = await refreshGuildCache(request.auth.sessionId);
    request.auth.cachedGuilds = guilds;
    return {
      user: request.auth.user,
      csrfToken: request.auth.csrfToken,
      guilds: guilds.map((guild) => ({
        id: guild.id,
        name: guild.name,
        icon: guild.icon,
        owner: guild.owner,
        accessLevel: guild.owner ? 'owner' : 'manage_guild',
        botPresent: false,
      })),
    };
  });
}
