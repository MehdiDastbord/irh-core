/** Moderation execution with hierarchy validation, cases and escalation. */

import { PermissionFlagsBits, type Guild, type GuildMember, type TextChannel } from 'discord.js';
import {
  createCase,
  createWarning,
  activeWarnings,
  decideEscalation,
  getModuleSettings,
  logger,
  type EscalationStep,
} from '@irh/db';
import { formatDuration } from '@irh/shared';
import { canActOn, safeDm, truncate } from '../lib/discord-utils.js';
import { errorEmbed, successEmbed, COLORS, baseEmbed } from '../lib/embed.js';
import { emitLog } from '../lib/logging.js';

const log = logger.child('moderation');

export interface PunishmentInput {
  guild: Guild;
  actor: GuildMember;
  target: GuildMember | null;
  targetId: string;
  action: 'ban' | 'kick' | 'timeout' | 'warn' | 'softban' | 'untimeout' | 'unban';
  reason?: string;
  durationMs?: number;
  deleteMessageSeconds?: number;
}

export interface PunishmentResult {
  ok: boolean;
  message: string;
  caseNumber?: number;
  escalated?: string;
}

const REQUIRED: Partial<Record<PunishmentInput['action'], bigint>> = {
  ban: PermissionFlagsBits.BanMembers,
  softban: PermissionFlagsBits.BanMembers,
  unban: PermissionFlagsBits.BanMembers,
  kick: PermissionFlagsBits.KickMembers,
  timeout: PermissionFlagsBits.ModerateMembers,
  untimeout: PermissionFlagsBits.ModerateMembers,
  warn: PermissionFlagsBits.ModerateMembers,
};

export async function executePunishment(input: PunishmentInput): Promise<PunishmentResult> {
  const { guild, actor, target, action, targetId } = input;
  const settings = await getModuleSettings<{
    enabled: boolean;
    requireReason: boolean;
    dmPunishedUsers: boolean;
    warnEscalation: EscalationStep[];
    defaultTimeoutMs: number;
    autoExpireDays: number;
  }>(await import('@irh/db').then((m) => m.requireGuildId(guild.id)), 'moderation');

  if (settings.enabled === false) return { ok: false, message: 'Moderation is disabled for this server.' };
  if (settings.requireReason && !input.reason?.trim()) return { ok: false, message: 'A reason is required for manual punishments.' };

  const required = REQUIRED[action];
  if (required && !actor.permissions.has(required)) {
    return { ok: false, message: 'You do not have the Discord permission required for that action.' };
  }

  if (action !== 'unban') {
    if (!target) return { ok: false, message: 'That member is not in this server.' };
    const check = canActOn(actor, target, required);
    if (!check.allowed) return { ok: false, message: check.message ?? 'Action denied.' };
  } else if (!actor.permissions.has(PermissionFlagsBits.BanMembers)) {
    return { ok: false, message: 'You need the Ban Members permission.' };
  }

  const reason = truncate(input.reason?.trim() || 'No reason provided', 400);
  const auditReason = `${actor.user.tag} (${actor.id}): ${reason}`;
  const internalId = await (await import('@irh/db')).requireGuildId(guild.id);
  const duration = input.durationMs ?? settings.defaultTimeoutMs ?? 600_000;

  try {
    switch (action) {
      case 'ban':
        await guild.members.ban(targetId, { reason: auditReason, deleteMessageSeconds: input.deleteMessageSeconds ?? 0 });
        break;
      case 'softban':
        await guild.members.ban(targetId, { reason: auditReason, deleteMessageSeconds: 86_400 });
        await guild.members.unban(targetId, 'Softban: messages removed').catch(() => undefined);
        break;
      case 'unban':
        await guild.members.unban(targetId, auditReason);
        break;
      case 'kick':
        await target!.kick(auditReason);
        break;
      case 'timeout':
        await target!.timeout(duration, auditReason);
        break;
      case 'untimeout':
        await target!.timeout(null, auditReason);
        break;
      case 'warn':
        break;
    }
  } catch (error) {
    log.warn('Discord action failed', { guildId: guild.id, action, error: String(error) });
    return { ok: false, message: 'Discord rejected the action. Check my permissions and role position.' };
  }

  if (settings.dmPunishedUsers && target) {
    await safeDm(target, {
      embeds: [
        baseEmbed({
          title: `You were ${action === 'untimeout' ? 'un-timed out' : action}ed in ${guild.name}`,
          description: `**Reason:** ${reason}${action === 'timeout' ? `\n**Duration:** ${formatDuration(duration)}` : ''}`,
          color: COLORS.danger,
        }),
      ],
    });
  }

  const moderationCase = await createCase({
    guildId: internalId,
    action,
    targetId,
    targetTag: target?.user.tag ?? null,
    moderatorId: actor.id,
    reason,
    durationMs: action === 'timeout' || action === 'ban' ? duration : null,
  });

  let escalated: string | undefined;
  if (action === 'warn') {
    await createWarning({ guildId: internalId, targetId, moderatorId: actor.id, reason, caseId: moderationCase.id });
    const warnings = await activeWarnings(internalId, targetId);
    const decision = decideEscalation(warnings.length, settings.warnEscalation ?? []);
    if (decision && target) {
      escalated = decision.action;
      if (decision.action === 'timeout') await target.timeout(decision.durationMs ?? 600_000, `Warning escalation (${warnings.length} warnings)`).catch(() => undefined);
      else if (decision.action === 'kick') await target.kick(`Warning escalation (${warnings.length} warnings)`).catch(() => undefined);
      else if (decision.action === 'ban') await guild.members.ban(targetId, { reason: `Warning escalation (${warnings.length} warnings)` }).catch(() => undefined);
      else if (decision.action === 'remove_roles') {
        const roles = target.roles.cache.filter((role) => role.managed === false && role.id !== guild.id);
        await target.roles.remove(roles, `Warning escalation (${warnings.length} warnings)`).catch(() => undefined);
      }
    }
  }

  await emitLog({
    guild,
    event: action === 'untimeout' ? 'member.timeoutRemove' : `mod.${action}`,
    summary: `${action.toUpperCase()} — ${target?.user.tag ?? targetId}\n**Reason:** ${reason}${escalated ? `\n**Escalated to:** ${escalated}` : ''}`,
    executorId: actor.id,
    targetId,
    color: COLORS.danger,
    fields: [
      { name: 'Case', value: `#${moderationCase.caseNumber}`, inline: true },
      ...(action === 'timeout' ? [{ name: 'Duration', value: formatDuration(duration), inline: true }] : []),
    ],
  });

  return {
    ok: true,
    message: `Case **#${moderationCase.caseNumber}** created.${escalated ? ` Escalation applied: **${escalated}**.` : ''}`,
    caseNumber: moderationCase.caseNumber,
    escalated,
  };
}

export async function purgeMessages(channel: TextChannel, amount: number, actorId: string): Promise<number> {
  const deleted = await channel.bulkDelete(Math.min(100, Math.max(1, amount)), true);
  await emitLog({
    guild: channel.guild,
    event: 'mod.purge',
    summary: `Purged ${deleted.size} message(s) in <#${channel.id}>`,
    executorId: actorId,
    channelId: channel.id,
  });
  return deleted.size;
}

export async function setChannelLocked(channel: TextChannel, locked: boolean, actorId: string): Promise<void> {
  const overwrite = channel.permissionOverwrites.cache.get(channel.guild.roles.everyone.id);
  await channel.permissionOverwrites.edit(
    channel.guild.roles.everyone,
    { SendMessages: locked ? false : null },
    { reason: `Channel ${locked ? 'locked' : 'unlocked'} by ${actorId}` },
  );
  void overwrite;
  await emitLog({
    guild: channel.guild,
    event: 'channel.update',
    summary: `Channel <#${channel.id}> ${locked ? 'locked' : 'unlocked'}`,
    executorId: actorId,
    channelId: channel.id,
    fields: [{ name: 'State', value: locked ? 'Locked' : 'Unlocked' }],
  });
}

export function buildCaseEmbed(input: {
  caseNumber: number;
  action: string;
  targetTag: string | null;
  moderatorId: string;
  reason: string | null;
  createdAt: Date;
  durationMs: number | null;
  active: boolean;
}) {
  return baseEmbed({
    title: `Case #${input.caseNumber} — ${input.action.toUpperCase()}`,
    color: input.active ? COLORS.warning : COLORS.muted,
    fields: [
      { name: 'Target', value: input.targetTag ?? 'Unknown', inline: true },
      { name: 'Moderator', value: `<@${input.moderatorId}>`, inline: true },
      { name: 'Reason', value: input.reason ?? 'No reason provided' },
      ...(input.durationMs ? [{ name: 'Duration', value: formatDuration(input.durationMs), inline: true }] : []),
      { name: 'Status', value: input.active ? 'Active' : 'Inactive', inline: true },
    ],
  });
}

export function punishmentFeedback(ok: boolean, message: string) {
  return ok ? successEmbed('Action applied', message) : errorEmbed('Action failed', message);
}
