/** Auto moderation: pure detection logic plus enforcement. */

import { PermissionFlagsBits, type Guild, type GuildMember, type Message } from 'discord.js';
import { createWarning, getModuleSettings, requireGuildId, logger } from '@irh/db';
import { emitLog } from '../lib/logging.js';
import { safeDm } from '../lib/discord-utils.js';
import { warnEmbed } from '../lib/embed.js';

const log = logger.child('automod');

export interface AutomodSettings {
  enabled: boolean;
  alertChannelId: string | null;
  spamEnabled: boolean;
  spamThreshold: number;
  spamWindowSec: number;
  mentionLimit: number;
  antiLink: boolean;
  antiInvite: boolean;
  capsEnabled: boolean;
  capsPercent: number;
  capsMinLength: number;
  duplicateEnabled: boolean;
  duplicateLimit: number;
  badWords: string[];
  allowedDomains: string[];
  allowedInviteCodes: string[];
  exemptRoleIds: string[];
  exemptChannelIds: string[];
  punishment: string;
  punishmentDurationMs: number;
  strikeLimit: number;
  strikeWindowMinutes: number;
  useDiscordAutoMod: boolean;
}

export interface DetectionInput {
  content: string;
  mentionCount: number;
  recent: { content: string; at: number }[];
  settings: AutomodSettings;
  now?: number;
}

export interface Violation {
  rule: 'spam' | 'mention' | 'link' | 'invite' | 'caps' | 'duplicate' | 'badword';
  detail: string;
}

const URL_REGEX = /https?:\/\/([^\s/$.?#].[^\s]*)/gi;
const INVITE_REGEX = /(?:discord\.(?:gg|com\/invite)|discordapp\.com\/invite)\/([a-z0-9-]+)/gi;

/** Pure detection so the rules can be unit tested without a gateway. */
export function detectViolation(input: DetectionInput): Violation | null {
  const { settings, content } = input;
  const now = input.now ?? Date.now();
  const lower = content.toLowerCase();

  if (settings.spamEnabled) {
    const windowMs = settings.spamWindowSec * 1000;
    const recent = input.recent.filter((entry) => now - entry.at <= windowMs);
    if (recent.length + 1 > settings.spamThreshold) {
      return { rule: 'spam', detail: `${recent.length + 1} messages within ${settings.spamWindowSec}s` };
    }
  }

  if (settings.duplicateEnabled && content.trim().length > 3) {
    const same = input.recent.filter((entry) => entry.content.trim().toLowerCase() === lower);
    if (same.length + 1 >= settings.duplicateLimit) {
      return { rule: 'duplicate', detail: `Repeated the same message ${same.length + 1} times` };
    }
  }

  if (settings.mentionLimit > 0 && input.mentionCount > settings.mentionLimit) {
    return { rule: 'mention', detail: `${input.mentionCount} mentions (limit ${settings.mentionLimit})` };
  }

  if (settings.antiInvite && INVITE_REGEX.test(content)) {
    INVITE_REGEX.lastIndex = 0;
    const codes = [...content.matchAll(INVITE_REGEX)].map((match) => (match[1] ?? '').toLowerCase());
    if (codes.some((code) => code && !settings.allowedInviteCodes.map((entry) => entry.toLowerCase()).includes(code))) {
      return { rule: 'invite', detail: 'Posted a Discord invite link' };
    }
    INVITE_REGEX.lastIndex = 0;
  }

  if (settings.antiLink) {
    const links = [...content.matchAll(URL_REGEX)].map((match) => (match[1] ?? '').toLowerCase());
    const blocked = links.filter((link) => !settings.allowedDomains.some((domain) => link.startsWith(domain.toLowerCase()) || link.includes(`.${domain.toLowerCase()}`)));
    URL_REGEX.lastIndex = 0;
    if (blocked.length) return { rule: 'link', detail: `Blocked domain: ${blocked[0]?.split('/')[0] ?? 'unknown'}` };
  }

  if (settings.badWords.length) {
    for (const word of settings.badWords) {
      const needle = word.trim().toLowerCase();
      if (!needle) continue;
      const pattern = new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (pattern.test(content)) return { rule: 'badword', detail: 'Matched a filtered word' };
    }
  }

  if (settings.capsEnabled && content.length >= settings.capsMinLength) {
    const letters = content.replace(/[^a-zA-Z]/g, '');
    if (letters.length >= settings.capsMinLength) {
      const upper = letters.replace(/[^A-Z]/g, '').length;
      const percent = Math.round((upper / letters.length) * 100);
      if (percent >= settings.capsPercent) return { rule: 'caps', detail: `${percent}% capital letters` };
    }
  }

  return null;
}

const recentMessages = new Map<string, { content: string; at: number }[]>();
const strikes = new Map<string, number[]>();

export function resetAutomodState(): void {
  recentMessages.clear();
  strikes.clear();
}

export async function loadAutomodSettings(guildId: string): Promise<AutomodSettings> {
  return getModuleSettings<AutomodSettings>(await requireGuildId(guildId), 'automod');
}

function isExempt(member: GuildMember, settings: AutomodSettings, channelId: string): boolean {
  if (member.permissions.has(PermissionFlagsBits.ManageMessages)) return true;
  if (member.id === member.guild.ownerId) return true;
  if (settings.exemptChannelIds?.includes(channelId)) return true;
  return member.roles.cache.some((role) => settings.exemptRoleIds?.includes(role.id));
}

export type AutomodOutcome = 'none' | 'deleted' | 'warned' | 'timedout' | 'kicked' | 'banned';

export async function handleAutomod(message: Message<true>): Promise<AutomodOutcome> {
  if (message.author.bot || !message.member || !message.guild) return 'none';
  let settings: AutomodSettings;
  try {
    settings = await loadAutomodSettings(message.guild.id);
  } catch {
    return 'none';
  }
  if (!settings.enabled) return 'none';
  if (isExempt(message.member, settings, message.channelId)) return 'none';

  const key = `${message.guild.id}:${message.author.id}`;
  const history = recentMessages.get(key) ?? [];
  const violation = detectViolation({
    content: message.content ?? '',
    mentionCount: message.mentions.users.size,
    recent: history,
    settings,
  });

  history.push({ content: message.content ?? '', at: Date.now() });
  const windowMs = Math.max(settings.spamWindowSec, 60) * 1000;
  recentMessages.set(
    key,
    history.filter((entry) => Date.now() - entry.at <= windowMs).slice(-25),
  );
  if (recentMessages.size > 5000) recentMessages.clear();

  if (!violation) return 'none';

  const strikeWindow = settings.strikeWindowMinutes * 60_000;
  const strikeList = (strikes.get(key) ?? []).filter((at) => Date.now() - at <= strikeWindow);
  strikeList.push(Date.now());
  strikes.set(key, strikeList);
  const escalated = strikeList.length >= settings.strikeLimit;

  let outcome: AutomodOutcome = 'deleted';
  if (settings.punishment !== 'none' || escalated) {
    const action = escalated ? 'timeout' : settings.punishment;
    try {
      switch (action) {
        case 'warn':
          await safeDm(message.member, { embeds: [warnEmbed('Automod warning', `**${violation.rule}**: ${violation.detail}`)] });
          outcome = 'warned';
          break;
        case 'timeout':
          await message.member.timeout(settings.punishmentDurationMs || 600_000, `Automod: ${violation.rule}`);
          outcome = 'timedout';
          break;
        case 'kick':
          await message.member.kick(`Automod: ${violation.rule}`);
          outcome = 'kicked';
          break;
        case 'ban':
          await message.guild.members.ban(message.author.id, { reason: `Automod: ${violation.rule}`, deleteMessageSeconds: 3600 });
          outcome = 'banned';
          break;
        case 'none':
          break;
        default:
          outcome = 'deleted';
      }
    } catch (error) {
      log.warn('Automod punishment failed', { guildId: message.guild.id, error: String(error) });
    }
  }

  if (settings.punishment !== 'none' || violation.rule === 'spam' || violation.rule === 'invite' || violation.rule === 'badword') {
    await message.delete().catch(() => undefined);
  }

  const internalId = await requireGuildId(message.guild.id);
  if (outcome !== 'deleted') {
    await createWarning({
      guildId: internalId,
      targetId: message.author.id,
      moderatorId: message.client.user?.id ?? 'system',
      reason: `Automod (${violation.rule}): ${violation.detail}`,
    }).catch(() => undefined);
  }

  await emitLog({
    guild: message.guild,
    event: 'security.incident',
    summary: `Automod triggered **${violation.rule}** in <#${message.channelId}> — ${violation.detail}`,
    executorId: message.author.id,
    targetId: message.author.id,
    channelId: message.channelId,
    messageId: message.id,
    bypassIgnore: true,
    fields: [
      { name: 'Rule', value: violation.rule, inline: true },
      { name: 'Action', value: outcome, inline: true },
      { name: 'Content', value: message.content?.slice(0, 500) || '—' },
    ],
  });

  return outcome;
}

/**
 * Sync keyword filters to Discord's native AutoMod. Best effort: requires the
 * Manage Guild permission; failures never break message handling.
 */
export async function syncDiscordAutoMod(guild: Guild, settings: AutomodSettings): Promise<boolean> {
  if (!settings.useDiscordAutoMod) return false;
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageGuild)) return false;
  try {
    const rules = await guild.autoModerationRules.fetch();
    const existing = rules.find((rule) => rule.name === 'IRH CORE Keyword Filter');
    const keywords = settings.badWords.filter(Boolean).slice(0, 1000);
    if (!keywords.length) {
      if (existing) await existing.delete('No keywords configured');
      return true;
    }
    const payload = {
      name: 'IRH CORE Keyword Filter',
      eventType: 1,
      triggerType: 1,
      triggerMetadata: { keywordFilter: keywords },
      actions: [{ type: 1, metadata: { customMessage: 'That word is not allowed here.' } }],
      enabled: true,
      reason: 'IRH CORE automod keyword sync',
    } as const;
    if (existing) await existing.edit(payload);
    else await guild.autoModerationRules.create(payload);
    return true;
  } catch (error) {
    log.debug('Discord AutoMod sync unavailable', { guildId: guild.id, error: String(error) });
    return false;
  }
}
