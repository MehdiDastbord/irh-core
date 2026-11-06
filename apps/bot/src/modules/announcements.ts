/** Announcement scheduling and delivery. */

import type { Client } from 'discord.js';
import { logger, prisma, requireGuildId } from '@irh/db';
import { baseEmbed, COLORS } from '../lib/embed.js';

const log = logger.child('announcements');

export function nextOccurrence(recurrence: string, from: Date): Date | null {
  const next = new Date(from);
  switch (recurrence) {
    case 'hourly':
      next.setHours(next.getHours() + 1);
      return next;
    case 'daily':
      next.setDate(next.getDate() + 1);
      return next;
    case 'weekly':
      next.setDate(next.getDate() + 7);
      return next;
    case 'monthly':
      next.setMonth(next.getMonth() + 1);
      return next;
    default:
      return null;
  }
}

export async function sendAnnouncement(client: Client, announcementId: string): Promise<boolean> {
  const announcement = await prisma.announcement.findUnique({ where: { id: announcementId } });
  if (!announcement || !announcement.enabled) return false;
  const channel = await client.channels.fetch(announcement.channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !('send' in channel)) return false;
  const embed = announcement.embed as { title?: string; description?: string; color?: number; image?: string } | null;
  const roles = (announcement.mentionRoleIds as string[]) ?? [];
  try {
    await channel.send({
      content: roles.map((roleId) => `<@&${roleId}>`).join(' ') || undefined,
      embeds: [
        baseEmbed({
          title: embed?.title ?? announcement.title ?? 'Announcement',
          description: embed?.description ?? announcement.body,
          color: embed?.color ?? COLORS.brand,
          image: embed?.image,
        }),
      ],
      allowedMentions: { roles },
    });
  } catch (error) {
    log.warn('Announcement delivery failed', { announcementId, error: String(error) });
    return false;
  }

  const next = nextOccurrence(announcement.recurrence, new Date());
  await prisma.announcement.update({
    where: { id: announcement.id },
    data: { lastRunAt: new Date(), nextRunAt: next, enabled: next ? announcement.enabled : false },
  });
  await prisma.loggingEvent.create({
    data: {
      guildId: announcement.guildId,
      event: 'announcement.sent',
      source: 'system',
      channelId: announcement.channelId,
      summary: `Announcement delivered to <#${announcement.channelId}>`,
    },
  }).catch(() => undefined);
  return true;
}

export async function processDueAnnouncements(client: Client): Promise<number> {
  const due = await prisma.announcement.findMany({
    where: { enabled: true, nextRunAt: { not: null, lte: new Date() } },
    take: 20,
  });
  let sent = 0;
  for (const announcement of due) {
    if (await sendAnnouncement(client, announcement.id)) sent += 1;
  }
  return sent;
}

export async function scheduleAnnouncement(guildId: string, input: { channelId: string; body: string; title?: string; runAt: Date }) {
  return prisma.announcement.create({
    data: {
      guildId: await requireGuildId(guildId),
      channelId: input.channelId,
      body: input.body,
      title: input.title ?? null,
      nextRunAt: input.runAt,
      recurrence: 'once',
      mentionRoleIds: [] as never,
    },
  });
}
