/** Leveling: XP awards, level-ups, rewards and rank embeds. */

import { type GuildMember } from 'discord.js';
import { getModuleSettings, logger, prisma, requireGuildId } from '@irh/db';
import { renderTemplate, xpForLevel, levelProgress } from '@irh/shared';
import { baseEmbed, COLORS, progressBar } from '../lib/embed.js';
import { emitLog } from '../lib/logging.js';

const log = logger.child('leveling');

export interface LevelingSettings {
  enabled: boolean;
  minXp: number;
  maxXp: number;
  cooldownSec: number;
  voiceXpPerMinute: number;
  announceLevelUp: boolean;
  announceChannelId: string | null;
  stackRewards: boolean;
  ignoredChannelIds: string[];
  ignoredRoleIds: string[];
  noXpRoleIds: string[];
  leaderboardSize: number;
}

const cooldowns = new Map<string, number>();

export function resetCooldowns(): void {
  cooldowns.clear();
}

export async function awardMessageXp(member: GuildMember, channelId: string): Promise<{ leveledUp: boolean; level?: number }> {
  const settings = await getModuleSettings<LevelingSettings>(await requireGuildId(member.guild.id), 'leveling');
  if (!settings.enabled) return { leveledUp: false };
  if (member.user.bot) return { leveledUp: false };
  if (settings.ignoredChannelIds?.includes(channelId)) return { leveledUp: false };
  if (member.roles.cache.some((role) => settings.ignoredRoleIds?.includes(role.id) || settings.noXpRoleIds?.includes(role.id))) {
    return { leveledUp: false };
  }

  const key = `${member.guild.id}:${member.id}`;
  const now = Date.now();
  const last = cooldowns.get(key) ?? 0;
  if (now - last < (settings.cooldownSec ?? 60) * 1000) return { leveledUp: false };
  cooldowns.set(key, now);
  if (cooldowns.size > 20_000) cooldowns.clear();

  const gained = Math.floor((settings.minXp ?? 15) + Math.random() * Math.max(1, (settings.maxXp ?? 25) - (settings.minXp ?? 15)));
  return applyXp(member, gained, 'message');
}

export async function awardVoiceXp(member: GuildMember, minutes: number): Promise<void> {
  const settings = await getModuleSettings<LevelingSettings>(await requireGuildId(member.guild.id), 'leveling');
  if (!settings.enabled || minutes <= 0) return;
  const gained = Math.floor((settings.voiceXpPerMinute ?? 5) * minutes);
  if (gained <= 0) return;
  await applyXp(member, gained, 'voice');
}

async function applyXp(member: GuildMember, gained: number, source: 'message' | 'voice'): Promise<{ leveledUp: boolean; level?: number }> {
  const internalId = await requireGuildId(member.guild.id);
  try {
    const current = await prisma.xPRecord.upsert({
      where: { guildId_discordId: { guildId: internalId, discordId: member.id } },
      create: {
        guildId: internalId,
        discordId: member.id,
        xp: gained,
        messages: source === 'message' ? 1 : 0,
        voiceSeconds: source === 'voice' ? gained * 6 : 0,
        lastXpAt: new Date(),
      },
      update: {
        xp: { increment: gained },
        ...(source === 'message' ? { messages: { increment: 1 } } : { voiceSeconds: { increment: gained * 6 } }),
        lastXpAt: new Date(),
      },
    });

    const newLevel = levelProgress(current.xp).level;
    if (newLevel <= current.level) return { leveledUp: false };

    await prisma.xPRecord.update({ where: { id: current.id }, data: { level: newLevel } });
    await grantLevelRewards(member, newLevel, internalId);
    await announceLevelUp(member, newLevel, internalId);
    await emitLog({
      guild: member.guild,
      event: 'level.up',
      summary: `${member.user.tag} reached level **${newLevel}**`,
      targetId: member.id,
    });
    return { leveledUp: true, level: newLevel };
  } catch (error) {
    log.warn('XP award failed', { guildId: member.guild.id, error: String(error) });
    return { leveledUp: false };
  }
}

async function grantLevelRewards(member: GuildMember, level: number, internalId: string): Promise<void> {
  const rewards = await prisma.levelReward.findMany({ where: { guildId: internalId, level: { lte: level } }, orderBy: { level: 'asc' } });
  if (!rewards.length) return;
  const settings = await getModuleSettings<LevelingSettings>(internalId, 'leveling');
  const applicable = settings.stackRewards ? rewards : rewards.filter((reward) => reward.level === level);
  for (const reward of applicable) {
    const role = member.guild.roles.cache.get(reward.roleId);
    if (!role) continue;
    if (member.roles.cache.has(role.id)) continue;
    await member.roles.add(role, `Level ${level} reward`).catch(() => undefined);
  }
  if (!settings.stackRewards) {
    const stale = rewards.filter((reward) => reward.level < level && !applicable.some((entry) => entry.id === reward.id));
    for (const reward of stale) {
      if (!member.roles.cache.has(reward.roleId)) continue;
      if (!reward.removeOnLower) continue;
      await member.roles.remove(reward.roleId, 'Level reward superseded').catch(() => undefined);
    }
  }
}

async function announceLevelUp(member: GuildMember, level: number, internalId: string): Promise<void> {
  const settings = await getModuleSettings<LevelingSettings>(internalId, 'leveling');
  if (!settings.announceLevelUp) return;
  const channel = settings.announceChannelId
    ? await member.guild.channels.fetch(settings.announceChannelId).catch(() => null)
    : null;
  const embed = baseEmbed({
    description: renderTemplate('{user} reached **level {level}**!', { user: `<@${member.id}>`, level }),
    color: COLORS.purple,
  });
  if (channel && channel.isTextBased() && 'send' in channel) await channel.send({ embeds: [embed] }).catch(() => undefined);
}

export function rankEmbed(input: {
  username: string;
  avatarUrl: string;
  xp: number;
  rank: number | null;
  level: number;
  messages: number;
  voiceSeconds: number;
}) {
  const progress = levelProgress(input.xp);
  return baseEmbed({
    title: `${input.username} — Level ${input.level}`,
    color: COLORS.purple,
    thumbnail: input.avatarUrl,
    fields: [
      { name: 'Rank', value: input.rank ? `#${input.rank}` : 'Unranked', inline: true },
      { name: 'XP', value: `${input.xp} / ${xpForLevel(input.level + 1)}`, inline: true },
      { name: 'Messages', value: String(input.messages), inline: true },
      { name: 'Voice time', value: `${Math.floor(input.voiceSeconds / 3600)}h ${Math.floor((input.voiceSeconds % 3600) / 60)}m`, inline: true },
      { name: 'Progress', value: `${progressBar(progress.percent)} ${progress.percent}%` },
    ],
  });
}

export async function memberRankData(guildId: string, discordId: string) {
  const internalId = await requireGuildId(guildId);
  const record = await prisma.xPRecord.findUnique({ where: { guildId_discordId: { guildId: internalId, discordId } } });
  if (!record) return null;
  const higher = await prisma.xPRecord.count({ where: { guildId: internalId, xp: { gt: record.xp } } });
  return { ...record, rank: higher + 1 };
}
