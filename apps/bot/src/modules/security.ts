/**
 * Security: anti-nuke, anti-raid, alt detection, honeypots and lockdown.
 * Detection uses sliding windows; responses are graduated to avoid false positives.
 */

import { PermissionFlagsBits, type Guild, type GuildMember, type AuditLogEvent } from 'discord.js';
import { getModuleSettings, logger, prisma, recordAudit, requireGuildId } from '@irh/db';
import { emitLog } from '../lib/logging.js';
import { safeDm } from '../lib/discord-utils.js';

const log = logger.child('security');

export interface SecuritySettings {
  enabled: boolean;
  alertChannelId: string | null;
  punishment: 'none' | 'remove_roles' | 'kick' | 'ban';
  antiNuke: boolean;
  antiNukeThreshold: number;
  antiNukeWindowSec: number;
  antiRaid: boolean;
  raidJoinThreshold: number;
  raidWindowSec: number;
  antiAlt: boolean;
  minAccountAgeDays: number;
  antiWebhook: boolean;
  antiMassBan: boolean;
  massActionThreshold: number;
  antiChannelDelete: boolean;
  antiRoleDelete: boolean;
  honeypotChannelIds: string[];
  honeypotAction: 'ban' | 'kick' | 'timeout';
  lockdown: boolean;
  lockdownChannelIds: string[];
  rollbackEnabled: boolean;
  trustedRoleIds: string[];
  trustedBotIds: string[];
  dmOwner: boolean;
}

const windows = new Map<string, number[]>();

/** Sliding-window counter. Returns true when the threshold is exceeded. */
export function exceeded(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const entries = (windows.get(key) ?? []).filter((at) => now - at <= windowMs);
  entries.push(now);
  windows.set(key, entries);
  if (windows.size > 10_000) windows.clear();
  return entries.length > limit;
}

export function resetWindows(): void {
  windows.clear();
}

export async function loadSecuritySettings(guildId: string): Promise<SecuritySettings> {
  return getModuleSettings<SecuritySettings>(await requireGuildId(guildId), 'security');
}

function isTrusted(member: GuildMember | null, settings: SecuritySettings): boolean {
  if (!member) return false;
  if (member.id === member.guild.ownerId) return true;
  if (member.user.bot && settings.trustedBotIds?.includes(member.id)) return true;
  return member.roles.cache.some((role) => settings.trustedRoleIds?.includes(role.id));
}

export async function recordIncident(input: {
  guild: Guild;
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  summary: string;
  actorId?: string | null;
  targetId?: string | null;
  details?: Record<string, unknown>;
  actionTaken?: string | null;
}): Promise<void> {
  const internalId = await requireGuildId(input.guild.id);
  const incident = await prisma.securityIncident.create({
    data: {
      guildId: internalId,
      type: input.type,
      severity: input.severity,
      summary: input.summary.slice(0, 1000),
      actorId: input.actorId ?? null,
      targetId: input.targetId ?? null,
      details: (input.details ?? {}) as never,
      actionTaken: input.actionTaken ?? null,
    },
  });
  await emitLog({
    guild: input.guild,
    event: 'security.incident',
    summary: `**${input.severity.toUpperCase()}** ${input.type}: ${input.summary}`,
    executorId: input.actorId ?? null,
    targetId: input.targetId ?? null,
    color: 0xff4757,
    bypassIgnore: true,
    fields: [
      { name: 'Incident', value: incident.id, inline: true },
      { name: 'Action', value: input.actionTaken ?? 'None', inline: true },
      ...(input.details ? [{ name: 'Details', value: JSON.stringify(input.details).slice(0, 900) }] : []),
    ],
  });
  void recordAudit({ guildId: internalId, action: 'security.incident', targetType: 'incident', targetId: incident.id, actorType: 'system', after: { type: input.type, severity: input.severity } });
}

/** Escalated response to a malicious actor. */
export async function respondToThreat(guild: Guild, actorId: string, settings: SecuritySettings, reason: string): Promise<string> {
  if (!actorId || actorId === guild.members.me?.id) return 'skipped';
  const member = await guild.members.fetch(actorId).catch(() => null);
  if (!member) return 'not_member';
  if (isTrusted(member, settings)) return 'trusted';
  const me = guild.members.me;
  if (!me || me.roles.highest.position <= member.roles.highest.position) return 'hierarchy_blocked';

  try {
    switch (settings.punishment) {
      case 'ban':
        await guild.members.ban(actorId, { reason: `IRH CORE security: ${reason}`, deleteMessageSeconds: 3600 });
        return 'banned';
      case 'kick':
        await member.kick(`IRH CORE security: ${reason}`);
        return 'kicked';
      case 'remove_roles': {
        const dangerous = member.roles.cache.filter(
          (role) =>
            !role.managed &&
            role.id !== guild.id &&
            (role.permissions.has(PermissionFlagsBits.Administrator) ||
              role.permissions.has(PermissionFlagsBits.ManageGuild) ||
              role.permissions.has(PermissionFlagsBits.ManageChannels) ||
              role.permissions.has(PermissionFlagsBits.ManageRoles) ||
              role.permissions.has(PermissionFlagsBits.BanMembers) ||
              role.permissions.has(PermissionFlagsBits.ManageWebhooks)),
        );
        if (!dangerous.size) return 'no_dangerous_roles';
        await member.roles.remove(dangerous, `IRH CORE security: ${reason}`);
        return 'roles_removed';
      }
      case 'none':
      default:
        return 'alert_only';
    }
  } catch (error) {
    log.warn('Security response failed', { guildId: guild.id, actorId, error: String(error) });
    return 'failed';
  }
}

/** Anti-nuke: destructive audit-log actions within a window. */
export async function handleDestructiveAction(input: {
  guild: Guild;
  type: AuditLogEvent;
  actorId: string | null;
  targetId: string | null;
  label: string;
}): Promise<void> {
  const settings = await loadSecuritySettings(input.guild.id).catch(() => null);
  if (!settings?.enabled || !settings.antiNuke) return;
  if (!input.actorId) return;

  const member = await input.guild.members.fetch(input.actorId).catch(() => null);
  if (isTrusted(member, settings)) return;

  const key = `nuke:${input.guild.id}:${input.actorId}`;
  if (!exceeded(key, settings.antiNukeThreshold, settings.antiNukeWindowSec * 1000)) return;

  const actionTaken = await respondToThreat(input.guild, input.actorId, settings, `${input.label} mass action`);
  await recordIncident({
    guild: input.guild,
    type: 'anti_nuke',
    severity: 'critical',
    summary: `${input.label} performed ${settings.antiNukeThreshold + 1}+ times within ${settings.antiNukeWindowSec}s`,
    actorId: input.actorId,
    targetId: input.targetId,
    actionTaken,
    details: { label: input.label },
  });
  if (settings.dmOwner) {
    const owner = await input.guild.fetchOwner().catch(() => null);
    if (owner) await safeDm(owner, `Security incident in **${input.guild.name}**: ${input.label} by ${input.actorId}. Action: ${actionTaken}`);
  }
}

/** Anti-raid: join velocity. Returns true when a raid is detected. */
export async function detectRaid(guild: Guild): Promise<SecuritySettings | null> {
  const settings = await loadSecuritySettings(guild.id).catch(() => null);
  if (!settings?.enabled || !settings.antiRaid) return null;
  if (!exceeded(`raid:${guild.id}`, settings.raidJoinThreshold, settings.raidWindowSec * 1000)) return null;
  await recordIncident({
    guild,
    type: 'anti_raid',
    severity: 'high',
    summary: `${settings.raidJoinThreshold + 1} joins within ${settings.raidWindowSec}s`,
    actionTaken: settings.lockdown ? 'lockdown_active' : 'logged',
  });
  return settings;
}

/** Alt detection for a joining member. */
export async function detectAlt(guild: Guild, member: GuildMember): Promise<boolean> {
  const settings = await loadSecuritySettings(guild.id).catch(() => null);
  if (!settings?.enabled || !settings.antiAlt) return false;
  const ageDays = (Date.now() - member.user.createdTimestamp) / 86_400_000;
  if (ageDays >= settings.minAccountAgeDays) return false;
  const actionTaken = await respondToThreat(guild, member.id, settings, `account younger than ${settings.minAccountAgeDays} days`);
  await recordIncident({
    guild,
    type: 'anti_alt',
    severity: 'medium',
    summary: `Suspicious account age: ${ageDays.toFixed(1)} days (minimum ${settings.minAccountAgeDays})`,
    actorId: member.id,
    actionTaken,
    details: { accountCreated: member.user.createdAt.toISOString() },
  });
  return true;
}

/** Lock or unlock configured channels (idempotent). */
export async function applyLockdown(guild: Guild, locked: boolean): Promise<number> {
  const settings = await loadSecuritySettings(guild.id).catch(() => null);
  if (!settings) return 0;
  let changed = 0;
  for (const channelId of settings.lockdownChannelIds ?? []) {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !('permissionOverwrites' in channel)) continue;
    try {
      await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: locked ? false : null }, { reason: `Lockdown ${locked ? 'enabled' : 'disabled'}` });
      changed += 1;
    } catch (error) {
      log.warn('Lockdown channel update failed', { channelId, error: String(error) });
    }
  }
  if (locked) {
    await guild.roles.everyone.setPermissions(guild.roles.everyone.permissions, 'Lockdown marker').catch(() => undefined);
  }
  await emitLog({
    guild,
    event: 'security.lockdown',
    summary: locked ? `Emergency lockdown enabled (${changed} channels locked)` : `Lockdown lifted (${changed} channels unlocked)`,
    bypassIgnore: true,
    color: locked ? 0xff4757 : 0x2ecc71,
  });
  return changed;
}

/** Honeypot: any message in a honeypot channel is punished. */
export async function handleHoneypot(guild: Guild, member: GuildMember, channelId: string): Promise<boolean> {
  const settings = await loadSecuritySettings(guild.id).catch(() => null);
  if (!settings?.enabled || !settings.honeypotChannelIds?.includes(channelId)) return false;
  if (isTrusted(member, settings)) return false;
  let actionTaken = 'logged';
  try {
    if (settings.honeypotAction === 'ban') {
      await guild.members.ban(member.id, { reason: 'Honeypot triggered', deleteMessageSeconds: 3600 });
      actionTaken = 'banned';
    } else if (settings.honeypotAction === 'kick') {
      await member.kick('Honeypot triggered');
      actionTaken = 'kicked';
    } else {
      await member.timeout(86_400_000, 'Honeypot triggered');
      actionTaken = 'timed_out';
    }
  } catch (error) {
    actionTaken = `failed: ${String(error).slice(0, 100)}`;
  }
  await prisma.honeypotChannel
    .upsert({
      where: { guildId_channelId: { guildId: await requireGuildId(guild.id), channelId } },
      create: { guildId: await requireGuildId(guild.id), channelId, action: settings.honeypotAction, triggered: 1 },
      update: { triggered: { increment: 1 } },
    })
    .catch(() => undefined);
  await recordIncident({
    guild,
    type: 'honeypot',
    severity: 'high',
    summary: `Honeypot channel <#${channelId}> triggered`,
    actorId: member.id,
    targetId: channelId,
    actionTaken,
  });
  return true;
}

/** Webhook abuse detection: newly created webhooks by a non-trusted actor. */
export async function handleWebhookCreation(guild: Guild, actorId: string | null, webhookId: string, webhookName: string, channelId: string | null): Promise<void> {
  const settings = await loadSecuritySettings(guild.id).catch(() => null);
  if (!settings?.enabled || !settings.antiWebhook) return;
  const member = actorId ? await guild.members.fetch(actorId).catch(() => null) : null;
  if (isTrusted(member, settings)) return;
  const actionTaken = actorId ? await respondToThreat(guild, actorId, settings, 'webhook creation') : 'unknown_actor';
  await recordIncident({
    guild,
    type: 'anti_webhook',
    severity: 'medium',
    summary: `Webhook **${webhookName}** (${webhookId}) created${channelId ? ` in <#${channelId}>` : ''}`,
    actorId,
    targetId: webhookId,
    actionTaken,
  });
}
