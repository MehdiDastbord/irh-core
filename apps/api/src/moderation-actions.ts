/**
 * Dashboard-initiated moderation. Uses the bot token but applies the same
 * hierarchy rules as the in-Discord commands, then writes a moderation case,
 * an audit record and a realtime event.
 */

import { canModerate, denialMessage, type ModerationDenial } from '@irh/shared';
import { createCase, createWarning, getModuleSettings, recordAudit } from '@irh/db';
import { discordApi, DiscordApiError, type DiscordMember, type DiscordRole } from './discord.js';
import { env } from './env.js';
import { broadcast } from './realtime.js';

let selfIdCache: string | null = null;

export async function botUserId(): Promise<string> {
  if (selfIdCache) return selfIdCache;
  selfIdCache = env.discord.clientId || '';
  return selfIdCache;
}

function highestPosition(roleIds: string[], roles: DiscordRole[], ownerId?: string | null, userId?: string) {
  if (ownerId && userId === ownerId) return Number.MAX_SAFE_INTEGER;
  let highest = 0;
  for (const role of roles) {
    if (roleIds.includes(role.id)) highest = Math.max(highest, role.position);
  }
  return highest;
}

export class ModerationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface DashboardActionInput {
  guildId: string;
  internalGuildId: string;
  actorId: string;
  targetId: string;
  action: 'ban' | 'unban' | 'kick' | 'timeout' | 'warn' | 'softban';
  reason?: string;
  durationMs?: number;
  deleteMessageSeconds?: number;
  automated?: boolean;
}

export async function performModeration(input: DashboardActionInput) {
  if (!/^\d{15,25}$/.test(input.targetId)) throw new ModerationError('Invalid member id.');
  const guild = await discordApi.guild(input.guildId);
  const [roles, targetMember, selfId] = await Promise.all([
    discordApi.guildRoles(input.guildId),
    input.action === 'unban'
      ? Promise.resolve(null)
      : discordApi.guildMember(input.guildId, input.targetId).catch(() => null),
    env.discord.clientId,
  ]);

  if (input.action !== 'unban' && !targetMember) {
    throw new ModerationError('That user is not a member of this server.', 404);
  }

  if (selfId) {
    const botMember = await discordApi.guildMember(input.guildId, selfId).catch(() => null);
    if (!botMember) throw new ModerationError('The bot is not in this server.', 409);
    const actorMember: DiscordMember | null =
      input.actorId === selfId ? botMember : await discordApi.guildMember(input.guildId, input.actorId).catch(() => null);

    if (actorMember && targetMember) {
      const check = canModerate({
        guild: {
          ownerId: guild.owner_id,
          botPosition: highestPosition(botMember.roles, roles),
        },
        actor: {
          id: input.actorId,
          highestRolePosition: highestPosition(actorMember.roles, roles, guild.owner_id, input.actorId),
          isOwner: input.actorId === guild.owner_id,
        },
        target: {
          id: input.targetId,
          highestRolePosition: highestPosition(targetMember.roles, roles, guild.owner_id, input.targetId),
          isOwner: input.targetId === guild.owner_id,
        },
        actorHasPermission: true,
      });
      if (!check.allowed) {
        throw new ModerationError(denialMessage(check.reason as ModerationDenial), 403);
      }
    }
  }

  const reason = input.reason?.slice(0, 400) || 'No reason provided';
  const auditReason = `${input.actorId === selfId ? 'IRH CORE' : `Dashboard (${input.actorId})`}: ${reason}`;

  try {
    switch (input.action) {
      case 'ban':
        await discordApi.ban(input.guildId, input.targetId, auditReason, input.deleteMessageSeconds ?? 0);
        break;
      case 'softban':
        await discordApi.ban(input.guildId, input.targetId, auditReason, 86_400);
        await discordApi.unban(input.guildId, input.targetId).catch(() => undefined);
        break;
      case 'unban':
        await discordApi.unban(input.guildId, input.targetId);
        break;
      case 'kick':
        await discordApi.kick(input.guildId, input.targetId);
        break;
      case 'timeout':
        await discordApi.timeout(input.guildId, input.targetId, input.durationMs ?? 600_000);
        break;
      case 'warn':
        break;
      default:
        throw new ModerationError('Unsupported action.');
    }
  } catch (error) {
    if (error instanceof DiscordApiError) {
      if (error.status === 403) throw new ModerationError('Discord rejected the action: missing permissions or role hierarchy.', 403);
      if (error.status === 404) throw new ModerationError('Discord could not find that member or ban.', 404);
    }
    throw error;
  }

  const settings = await getModuleSettings<{ autoExpireDays: number }>(input.internalGuildId, 'moderation');
  const moderationCase = await createCase({
    guildId: input.internalGuildId,
    action: input.action,
    targetId: input.targetId,
    targetTag: targetMember?.user ? `${targetMember.user.username}` : null,
    moderatorId: input.actorId,
    reason,
    durationMs: input.action === 'timeout' || input.action === 'ban' ? input.durationMs ?? null : null,
    automated: input.automated ?? false,
  });

  if (input.action === 'warn') {
    await createWarning({ guildId: input.internalGuildId, targetId: input.targetId, moderatorId: input.actorId, reason, caseId: moderationCase.id });
  }

  await recordAudit({
    guildId: input.internalGuildId,
    actorId: input.actorId,
    action: `moderation.${input.action}`,
    targetType: 'member',
    targetId: input.targetId,
    after: { caseNumber: moderationCase.caseNumber, reason, durationMs: input.durationMs ?? null },
  });
  broadcast({ type: 'moderation.case', guildId: input.guildId, payload: { caseNumber: moderationCase.caseNumber, action: input.action } });
  void settings;

  return {
    ok: true,
    case: moderationCase,
    message: `${input.action} recorded as case #${moderationCase.caseNumber}.`,
  };
}
