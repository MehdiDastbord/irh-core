/**
 * Logging engine.
 *
 * Gateway events are processed separately from audit-log correlation:
 *  - `emitLog` receives already-known facts from a gateway event handler.
 *  - `correlateExecutor` fetches the audit log separately, only when a handler
 *    needs an executor, and returns `null` when Discord has no entry yet.
 *
 * Missing data is never invented: absent values simply omit the embed field.
 */

import { AuditLogEvent, EmbedBuilder, type Guild } from 'discord.js';
import type { TextChannel } from 'discord.js';
import { logger as rootLogger, prisma, requireGuildId } from '@irh/db';
import { LOG_EVENTS, logEventDef } from '@irh/shared';
import { BRAND_FOOTER, COLORS } from './embed.js';
import { fullTimestamp, truncate } from './discord-utils.js';
import { settings } from './settings.js';

const logger = rootLogger.child('logging');

export interface LogInput {
  guild: Guild;
  event: string;
  summary: string;
  executorId?: string | null;
  targetId?: string | null;
  channelId?: string | null;
  messageId?: string | null;
  source?: 'gateway' | 'auditlog' | 'system' | 'api';
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  data?: Record<string, unknown>;
  /** Skip the ignore-role/channel checks (used by security-critical events). */
  bypassIgnore?: boolean;
}

interface LogConfig {
  enabled: boolean;
  channelIds: string[];
  color: number | null;
  ignoreRoleIds: string[];
  ignoreChannelIds: string[];
}

interface GlobalLogSettings {
  enabled: boolean;
  defaultChannelId: string | null;
  ignoreBots: boolean;
  storeHistory: boolean;
  retentionDays: number;
  ignoreRoleIds: string[];
  ignoreChannelIds: string[];
}

const GROUP_COLORS: Record<string, number> = {
  Messages: COLORS.info,
  Members: COLORS.success,
  Punishments: COLORS.danger,
  'Roles & Channels': COLORS.purple,
  Voice: 0x1abc9c,
  Server: COLORS.brand,
  Integrations: 0x00b0f4,
  Community: 0xeb459e,
  Security: COLORS.security,
  System: COLORS.muted,
};

const configCache = new Map<string, { configs: Map<string, LogConfig>; global: GlobalLogSettings; expiresAt: number }>();
const TTL_MS = 20_000;

export function invalidateLoggingCache(guildId?: string): void {
  if (!guildId) configCache.clear();
  else configCache.delete(guildId);
}

async function loadConfig(guildId: string) {
  const cached = configCache.get(guildId);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const [global, rows] = await Promise.all([
    settings<GlobalLogSettings>(guildId, 'logging'),
    prisma.loggingConfiguration.findMany({ where: { guildId: await requireGuildId(guildId) } }),
  ]);
  const configs = new Map<string, LogConfig>();
  for (const row of rows) {
    configs.set(row.event, {
      enabled: row.enabled,
      channelIds: (row.channelIds as string[]) ?? [],
      color: row.color,
      ignoreRoleIds: (row.ignoreRoleIds as string[]) ?? [],
      ignoreChannelIds: (row.ignoreChannelIds as string[]) ?? [],
    });
  }
  const entry = { configs, global, expiresAt: Date.now() + TTL_MS };
  configCache.set(guildId, entry);
  return entry;
}

/** Build the embed for a log entry. Exported for unit tests. */
export function buildLogEmbed(input: {
  eventLabel: string;
  group: string;
  summary: string;
  executorId?: string | null;
  targetId?: string | null;
  channelId?: string | null;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  timestamp?: Date;
}): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(input.color ?? GROUP_COLORS[input.group] ?? COLORS.brand)
    .setAuthor({ name: `IRH CORE • ${input.eventLabel}` })
    .setDescription(truncate(input.summary, 4000))
    .setTimestamp(input.timestamp ?? new Date())
    .setFooter({ text: BRAND_FOOTER });

  if (input.executorId) embed.addFields({ name: 'Executor', value: `<@${input.executorId}>\n\`${input.executorId}\``, inline: true });
  if (input.targetId) embed.addFields({ name: 'Target', value: `<@${input.targetId}>\n\`${input.targetId}\``, inline: true });
  if (input.channelId) embed.addFields({ name: 'Channel', value: `<#${input.channelId}>`, inline: true });
  if (input.fields?.length) {
    embed.addFields(
      input.fields.slice(0, 20).map((field) => ({
        name: truncate(field.name, 256) || '\u200b',
        value: truncate(field.value || '—', 1024),
        inline: field.inline ?? false,
      })),
    );
  }
  return embed;
}

export async function emitLog(input: LogInput): Promise<void> {
  const { guild } = input;
  const definition = logEventDef(input.event);
  if (!definition) {
    logger.warn('Unknown log event', { event: input.event, guildId: guild.id });
    return;
  }

  let config: LogConfig | undefined;
  let global: GlobalLogSettings = {
    enabled: true,
    defaultChannelId: null,
    ignoreBots: true,
    storeHistory: true,
    retentionDays: 90,
    ignoreRoleIds: [],
    ignoreChannelIds: [],
  };
  try {
    const loaded = await loadConfig(guild.id);
    config = loaded.configs.get(input.event);
    global = loaded.global as GlobalLogSettings;
  } catch (error) {
    logger.warn('Failed to load logging config', { guildId: guild.id, error: String(error) });
  }

  if (!global.enabled) return;
  if (!input.bypassIgnore) {
    if (input.channelId && global.ignoreChannelIds?.includes(input.channelId)) return;
    if (config?.ignoreChannelIds?.includes(input.channelId ?? '')) return;
    const member = input.executorId ? guild.members.cache.get(input.executorId) : null;
    if (member && (global.ignoreRoleIds ?? []).some((roleId) => member.roles.cache.has(roleId))) return;
    if (member && (config?.ignoreRoleIds ?? []).some((roleId) => member.roles.cache.has(roleId))) return;
    if (global.ignoreBots && member?.user.bot) return;
  }

  const enabled = config ? config.enabled : false;
  const destinations = (config?.channelIds ?? []).filter(Boolean);
  if (!enabled && destinations.length === 0) {
    // Not routed anywhere — still keep searchable history if enabled.
    await persist(input, definition.group);
    return;
  }

  const targets = destinations.length ? destinations : global.defaultChannelId ? [global.defaultChannelId] : [];
  const embed = buildLogEmbed({
    eventLabel: definition.label,
    group: definition.group,
    summary: input.summary,
    executorId: input.executorId ?? null,
    targetId: input.targetId ?? null,
    channelId: input.channelId ?? null,
    color: config?.color ?? input.color,
    fields: input.fields,
  });

  for (const channelId of targets.slice(0, 5)) {
    try {
      const channel = await guild.channels.fetch(channelId).catch(() => null);
      if (channel && channel.isTextBased() && 'send' in channel) {
        await (channel as TextChannel).send({ embeds: [embed], allowedMentions: { parse: [] } });
      } else {
        logger.debug('Log destination unavailable', { channelId, guildId: guild.id });
      }
    } catch (error) {
      logger.warn('Failed to deliver log entry', { channelId, guildId: guild.id, error: String(error) });
    }
  }

  await persist(input, definition.group);
}

async function persist(input: LogInput, group: string): Promise<void> {
  try {
    const global = await settings<GlobalLogSettings>(input.guild.id, 'logging');
    if (global.storeHistory === false) return;
    await prisma.loggingEvent.create({
      data: {
        guildId: await requireGuildId(input.guild.id),
        event: input.event,
        source: input.source ?? 'gateway',
        executorId: input.executorId ?? null,
        targetId: input.targetId ?? null,
        channelId: input.channelId ?? null,
        messageId: input.messageId ?? null,
        summary: truncate(input.summary, 1800),
        data: {
          group,
          ...(input.fields ? { fields: input.fields } : {}),
          ...(input.data ?? {}),
        } as never,
      },
    });
  } catch (error) {
    logger.warn('Failed to persist log history', { event: input.event, error: String(error) });
  }
}

/**
 * Find who performed an action using the audit log.
 * Returns null when Discord has no matching entry (e.g. actions by the owner
 * are sometimes absent, or the audit log permission is missing).
 */
export async function correlateExecutor(
  guild: Guild,
  type: AuditLogEvent,
  targetId: string,
  windowMs = 15_000,
): Promise<string | null> {
  try {
    const logs = await guild.fetchAuditLogs({ type, limit: 8 });
    const cutoff = Date.now() - windowMs;
    for (const entry of logs.entries.values()) {
      if (entry.createdTimestamp < cutoff) continue;
      const target = entry.target as { id?: string } | null;
      if (target?.id === targetId) return entry.executor?.id ?? null;
    }
  } catch (error) {
    logger.debug('Audit log correlation unavailable', { guildId: guild.id, type, error: String(error) });
  }
  return null;
}

export function allLogEvents(): typeof LOG_EVENTS {
  return LOG_EVENTS;
}

export function logEventLabel(event: string): string {
  return logEventDef(event)?.label ?? event;
}

export function describeTimestamp(date: Date | null | undefined): string {
  return fullTimestamp(date);
}
