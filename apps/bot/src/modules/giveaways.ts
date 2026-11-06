/** Giveaways: persistent state, eligibility, drawing and rerolls. */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Guild } from 'discord.js';
import { getModuleSettings, logger, prisma } from '@irh/db';
import { pickRandom, formatDuration } from '@irh/shared';
import { baseEmbed, COLORS } from '../lib/embed.js';
import { emitLog } from '../lib/logging.js';

const log = logger.child('giveaways');

export interface GiveawayRow {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string | null;
  prize: string;
  description: string | null;
  winnerCount: number;
  hostId: string;
  requiredRoleIds: string[];
  bonusRoles: string[];
  minAccountAgeDays: number;
  minServerAgeDays: number;
  endsAt: Date;
  status: string;
  winners: string[];
  pausedAt: Date | null;
  totalPausedMs: number;
}

/** Pure eligibility check for testability. */
export function checkEligibility(
  input: {
    requiredRoleIds: string[];
    memberRoleIds: string[];
    minAccountAgeDays: number;
    accountCreatedAt: Date;
    minServerAgeDays: number;
    joinedAt: Date | null;
    now?: number;
    isBot?: boolean;
  },
): { eligible: boolean; reason?: string } {
  const now = input.now ?? Date.now();
  if (input.isBot) return { eligible: false, reason: 'Bots cannot enter giveaways.' };
  if (input.requiredRoleIds.length && !input.requiredRoleIds.some((roleId) => input.memberRoleIds.includes(roleId))) {
    return { eligible: false, reason: 'You are missing a required role.' };
  }
  const accountAge = (now - input.accountCreatedAt.getTime()) / 86_400_000;
  if (input.minAccountAgeDays > 0 && accountAge < input.minAccountAgeDays) {
    return { eligible: false, reason: `Your account must be at least ${input.minAccountAgeDays} days old.` };
  }
  if (input.minServerAgeDays > 0) {
    if (!input.joinedAt) return { eligible: false, reason: 'I could not determine when you joined.' };
    const serverAge = (now - input.joinedAt.getTime()) / 86_400_000;
    if (serverAge < input.minServerAgeDays) return { eligible: false, reason: `You must be in the server for ${input.minServerAgeDays} more day(s).` };
  }
  return { eligible: true };
}

export function giveawayEmbed(giveaway: GiveawayRow, entries: number): ReturnType<typeof baseEmbed> {
  const ended = giveaway.status === 'ended';
  return baseEmbed({
    title: `🎉 ${giveaway.prize}`,
    description:
      giveaway.description ??
      `React with the button to enter!\n\n**Winners:** ${giveaway.winnerCount}\n**Ends:** <t:${Math.floor(giveaway.endsAt.getTime() / 1000)}:R>`,
    color: ended ? COLORS.muted : COLORS.purple,
    fields: [
      { name: 'Entries', value: String(entries), inline: true },
      { name: 'Hosted by', value: `<@${giveaway.hostId}>`, inline: true },
      { name: 'Status', value: giveaway.status, inline: true },
      ...(ended && giveaway.winners.length ? [{ name: 'Winners', value: giveaway.winners.map((id) => `<@${id}>`).join(', ') }] : []),
      ...(giveaway.requiredRoleIds.length ? [{ name: 'Required roles', value: giveaway.requiredRoleIds.map((id) => `<@&${id}>`).join(' ') }] : []),
      ...(giveaway.minAccountAgeDays ? [{ name: 'Minimum account age', value: `${giveaway.minAccountAgeDays} days`, inline: true }] : []),
    ],
  });
}

export function giveawayComponents(id: string, disabled = false) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`gw:enter:${id}`).setLabel(disabled ? 'Ended' : 'Enter giveaway').setStyle(ButtonStyle.Primary).setEmoji('🎉').setDisabled(disabled),
      new ButtonBuilder().setCustomId(`gw:participants:${id}`).setLabel('Entries').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

export async function startGiveaway(client: { channels: { fetch: (id: string) => Promise<unknown> } }, giveawayId: string): Promise<void> {
  const giveaway = await prisma.giveaway.findUnique({ where: { id: giveawayId } });
  if (!giveaway || giveaway.status === 'ended') return;
  const row: GiveawayRow = {
    ...giveaway,
    requiredRoleIds: (giveaway.requiredRoleIds as string[]) ?? [],
    bonusRoles: (giveaway.bonusRoles as string[]) ?? [],
    winners: (giveaway.winners as string[]) ?? [],
  };
  if (giveaway.messageId) return;
  const channel = (await client.channels.fetch(giveaway.channelId).catch(() => null)) as { send?: (payload: unknown) => Promise<{ id: string }> } | null;
  if (!channel?.send) return;
  const message = await channel.send({ embeds: [giveawayEmbed(row, 0)], components: giveawayComponents(giveaway.id) });
  await prisma.giveaway.update({ where: { id: giveaway.id }, data: { messageId: message.id, status: 'running' } });
  await emitLog({
    guild: (await client.channels.fetch(giveaway.channelId).catch(() => null)) as never as Guild,
    event: 'giveaway.create',
    summary: `Giveaway started: **${giveaway.prize}**`,
    executorId: giveaway.hostId,
    channelId: giveaway.channelId,
  }).catch(() => undefined);
}

export async function drawWinners(giveawayId: string, count?: number): Promise<string[]> {
  const giveaway = await prisma.giveaway.findUnique({ where: { id: giveawayId }, include: { entries: true } });
  if (!giveaway) return [];
  const winnersCount = Math.min(count ?? giveaway.winnerCount, giveaway.entries.length);
  if (winnersCount <= 0) return [];
  const pool = [...giveaway.entries];
  const winners: string[] = [];
  while (winners.length < winnersCount && pool.length) {
    const picked = pickRandom(pool);
    if (!picked) break;
    winners.push(picked.discordId);
    pool.splice(pool.indexOf(picked), 1);
  }
  return winners;
}

export interface EndResult {
  winners: string[];
  entries: number;
  prize: string;
}

export async function endGiveaway(giveawayId: string, options: { reroll?: boolean; rerollCount?: number } = {}): Promise<EndResult | null> {
  const giveaway = await prisma.giveaway.findUnique({ where: { id: giveawayId }, include: { entries: true } });
  if (!giveaway) return null;

  if (options.reroll) {
    const winners = await drawWinners(giveawayId, options.rerollCount ?? 1);
    const previous = (giveaway.winners as string[]) ?? [];
    const updated = [...previous, ...winners];
    await prisma.giveaway.update({ where: { id: giveaway.id }, data: { winners: updated as never } });
    await publishResults(giveaway.guildId, giveaway.channelId, giveaway.prize, winners, 'Reroll');
    return { winners, entries: giveaway.entries.length, prize: giveaway.prize };
  }

  if (giveaway.status === 'ended') return { winners: (giveaway.winners as string[]) ?? [], entries: giveaway.entries.length, prize: giveaway.prize };

  const winners = await drawWinners(giveawayId);
  await prisma.giveaway.update({
    where: { id: giveaway.id },
    data: { status: 'ended', endedAt: new Date(), winners: winners as never },
  });
  await publishResults(giveaway.guildId, giveaway.channelId, giveaway.prize, winners, 'Giveaway ended');
  await emitLog({
    guild: (await (await import('../lib/client-registry.js')).getClient()?.channels.fetch(giveaway.channelId).catch(() => null)) as never as Guild,
    event: 'giveaway.end',
    summary: `Giveaway ended: **${giveaway.prize}** — winners: ${winners.map((id) => `<@${id}>`).join(', ') || 'none'}`,
    channelId: giveaway.channelId,
  }).catch(() => undefined);
  return { winners, entries: giveaway.entries.length, prize: giveaway.prize };
}

async function publishResults(guildInternalId: string, channelId: string, prize: string, winners: string[], title: string): Promise<void> {
  try {
    const { getClient } = await import('../lib/client-registry.js');
    const client = getClient();
    if (!client) return;
    const channel = (await client.channels.fetch(channelId).catch(() => null)) as { send?: (payload: unknown) => Promise<unknown> } | null;
    if (!channel?.send) return;
    const giveaway = await prisma.giveaway.findFirst({ where: { guildId: guildInternalId, channelId, prize } });
    const row = giveaway
      ? ({
          ...giveaway,
          requiredRoleIds: (giveaway.requiredRoleIds as string[]) ?? [],
          bonusRoles: (giveaway.bonusRoles as string[]) ?? [],
          winners: winners,
        } as GiveawayRow)
      : null;
    const entries = giveaway ? await prisma.giveawayEntry.count({ where: { giveawayId: giveaway.id } }) : 0;
    await channel.send({
      content: winners.length ? winners.map((id) => `<@${id}>`).join(' ') : 'No valid entries.',
      embeds: [
        baseEmbed({
          title,
          description: row ? undefined : `**${prize}**`,
          color: COLORS.success,
          fields: [
            { name: 'Prize', value: prize, inline: true },
            { name: 'Winners', value: winners.map((id) => `<@${id}>`).join('\n') || 'No winners', inline: true },
            { name: 'Entries', value: String(entries), inline: true },
          ],
        }),
      ],
      components: giveaway ? giveawayComponents(giveaway.id, true) : [],
    });
    if (giveaway?.messageId) {
      const message = await channel.send; // keep type usage explicit
      void message;
    }
  } catch (error) {
    log.warn('Failed to publish giveaway results', { channelId, error: String(error) });
  }
}

export async function enterGiveaway(
  giveawayId: string,
  member: { id: string; roles: { cache: Map<string, unknown> }; user: { bot: boolean; createdAt: Date }; joinedAt: Date | null },
): Promise<{ ok: boolean; message: string; bonus?: number }> {
  const giveaway = await prisma.giveaway.findUnique({ where: { id: giveawayId } });
  if (!giveaway) return { ok: false, message: 'That giveaway no longer exists.' };
  if (giveaway.status !== 'running') return { ok: false, message: 'That giveaway is not accepting entries.' };
  if (giveaway.endsAt.getTime() < Date.now()) return { ok: false, message: 'That giveaway has ended.' };

  const settings = await getModuleSettings<{ bonusEntries: number }>(giveaway.guildId, 'giveaways');
  const eligibility = checkEligibility({
    requiredRoleIds: (giveaway.requiredRoleIds as string[]) ?? [],
    memberRoleIds: [...member.roles.cache.keys()],
    minAccountAgeDays: giveaway.minAccountAgeDays,
    accountCreatedAt: member.user.createdAt,
    minServerAgeDays: giveaway.minServerAgeDays,
    joinedAt: member.joinedAt,
    isBot: member.user.bot,
  });
  if (!eligibility.eligible) return { ok: false, message: eligibility.reason ?? 'You cannot enter this giveaway.' };

  const bonusRoles = (giveaway.bonusRoles as string[]) ?? [];
  const bonus = 1 + (bonusRoles.some((roleId) => member.roles.cache.has(roleId)) ? (settings.bonusEntries ?? 2) - 1 : 0);
  try {
    await prisma.giveawayEntry.upsert({
      where: { giveawayId_discordId: { giveawayId, discordId: member.id } },
      create: { giveawayId, discordId: member.id, bonusEntries: bonus },
      update: {},
    });
  } catch (error) {
    log.warn('Giveaway entry failed', { giveawayId, error: String(error) });
    return { ok: false, message: 'Could not save your entry. Try again.' };
  }
  return { ok: true, message: bonus > 1 ? `You are in! Bonus entries applied (${bonus}x).` : 'You are in! Good luck.', bonus };
}

export function giveawaySummary(giveaway: { prize: string; endsAt: Date; status: string }): string {
  return `**${giveaway.prize}** · ${giveaway.status} · ends in ${formatDuration(Math.max(0, giveaway.endsAt.getTime() - Date.now()))}`;
}
