/** Guild membership + dashboard overview data. */

import { prisma } from './client.js';
import { getAllSettings } from './settings.js';
import { moderationStats } from './moderation.js';
import { ticketStats } from './tickets.js';
import { growthSeries, activityTotals, latestSnapshot } from './stats.js';
import { jobStats } from './jobs.js';

export async function syncGuildsFromDiscord(guilds: {
  id: string;
  name: string;
  icon: string | null;
  ownerId: string | null;
  memberCount?: number;
}[]) {
  const results = [];
  for (const guild of guilds) {
    results.push(
      await prisma.guild.upsert({
        where: { discordId: guild.id },
        create: {
          discordId: guild.id,
          name: guild.name,
          icon: guild.icon,
          ownerId: guild.ownerId,
          memberCount: guild.memberCount ?? 0,
        },
        update: {
          name: guild.name,
          icon: guild.icon,
          ownerId: guild.ownerId,
          ...(guild.memberCount === undefined ? {} : { memberCount: guild.memberCount }),
        },
      }),
    );
  }
  return results;
}

export async function markGuildLeft(discordGuildId: string) {
  await prisma.guild.updateMany({ where: { discordId: discordGuildId }, data: { botJoinedAt: new Date(0) } });
}

export async function guildOverview(guildId: string) {
  const [settings, moderation, tickets, series, activity, snapshot, jobs, openIncidents, activeGiveaways, settingsUpdated] =
    await Promise.all([
      getAllSettings(guildId),
      moderationStats(guildId),
      ticketStats(guildId),
      growthSeries(guildId, 14),
      activityTotals(guildId, 7),
      latestSnapshot(guildId),
      jobStats(),
      prisma.securityIncident.count({ where: { guildId, status: 'open' } }),
      prisma.giveaway.count({ where: { guildId, status: { in: ['running', 'paused', 'scheduled'] } } }),
      prisma.guildSetting.aggregate({ where: { guildId }, _max: { updatedAt: true } }),
    ]);

  const enabledModules = Object.entries(settings)
    .filter(([, data]) => data.enabled !== false)
    .map(([moduleId]) => moduleId);

  return {
    memberCount: snapshot?.memberCount ?? 0,
    onlineCount: snapshot?.onlineCount ?? 0,
    boostCount: snapshot?.boostCount ?? 0,
    enabledModules,
    moderation,
    tickets,
    activity,
    growth: series,
    securityIncidents: openIncidents,
    activeGiveaways,
    scheduledJobs: jobs,
    lastSettingsUpdate: settingsUpdated._max.updatedAt ?? null,
  };
}

export async function guildLogStats(guildId: string) {
  const grouped = await prisma.loggingEvent.groupBy({ by: ['event'], where: { guildId }, _count: { _all: true } });
  return grouped.map((row) => ({ event: row.event, count: row._count._all }));
}

export async function guildMemberCount(guildId: string, options: { includeLeft?: boolean } = {}) {
  return prisma.guildMember.count({ where: { guildId, ...(options.includeLeft ? {} : { leftAt: null }) } });
}

/** Purge expired log history + audit records per retention policy. */
export async function purgeOldLogs(guildId: string, retentionDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - Math.max(7, retentionDays) * 86_400_000);
  const result = await prisma.loggingEvent.deleteMany({ where: { guildId, createdAt: { lt: cutoff } } });
  return result.count;
}
