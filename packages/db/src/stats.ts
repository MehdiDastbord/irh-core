/** Guild statistics snapshots and dashboard aggregates. */

import { prisma } from './client.js';
import { dateKey } from '@irh/shared';

export async function recordSnapshot(guildId: string, data: {
  memberCount?: number;
  onlineCount?: number;
  boostCount?: number;
  messages?: number;
  joins?: number;
  leaves?: number;
  inviteJoins?: number;
  ticketsOpened?: number;
  ticketsClosed?: number;
  date?: string;
}) {
  const date = data.date ?? dateKey();
  return prisma.statSnapshot.upsert({
    where: { guildId_date: { guildId, date } },
    create: {
      guildId,
      date,
      memberCount: data.memberCount ?? 0,
      onlineCount: data.onlineCount ?? 0,
      boostCount: data.boostCount ?? 0,
      messages: data.messages ?? 0,
      joins: data.joins ?? 0,
      leaves: data.leaves ?? 0,
      inviteJoins: data.inviteJoins ?? 0,
      ticketsOpened: data.ticketsOpened ?? 0,
      ticketsClosed: data.ticketsClosed ?? 0,
    },
    update: {
      ...(data.memberCount === undefined ? {} : { memberCount: data.memberCount }),
      ...(data.onlineCount === undefined ? {} : { onlineCount: data.onlineCount }),
      ...(data.boostCount === undefined ? {} : { boostCount: data.boostCount }),
      ...(data.messages === undefined ? {} : { messages: { increment: data.messages } }),
      ...(data.joins === undefined ? {} : { joins: { increment: data.joins } }),
      ...(data.leaves === undefined ? {} : { leaves: { increment: data.leaves } }),
      ...(data.inviteJoins === undefined ? {} : { inviteJoins: { increment: data.inviteJoins } }),
      ...(data.ticketsOpened === undefined ? {} : { ticketsOpened: { increment: data.ticketsOpened } }),
      ...(data.ticketsClosed === undefined ? {} : { ticketsClosed: { increment: data.ticketsClosed } }),
    },
  });
}

export async function incrementStat(guildId: string, field: 'messages' | 'joins' | 'leaves' | 'inviteJoins' | 'ticketsOpened' | 'ticketsClosed', amount = 1) {
  const date = dateKey();
  await prisma.statSnapshot.upsert({
    where: { guildId_date: { guildId, date } },
    create: { guildId, date, [field]: amount } as never,
    update: { [field]: { increment: amount } } as never,
  });
}

export async function growthSeries(guildId: string, days = 30) {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await prisma.statSnapshot.findMany({
    where: { guildId, createdAt: { gte: since } },
    orderBy: { date: 'asc' },
    take: days,
  });
  return rows.map((row) => ({
    date: row.date,
    members: row.memberCount,
    online: row.onlineCount,
    boosts: row.boostCount,
    messages: row.messages,
    joins: row.joins,
    leaves: row.leaves,
    invites: row.inviteJoins,
  }));
}

export async function latestSnapshot(guildId: string) {
  return prisma.statSnapshot.findFirst({ where: { guildId }, orderBy: { date: 'desc' } });
}

export async function activityTotals(guildId: string, days = 7) {
  const since = new Date(Date.now() - days * 86_400_000);
  const aggregate = await prisma.statSnapshot.aggregate({
    where: { guildId, createdAt: { gte: since } },
    _sum: { messages: true, joins: true, leaves: true, inviteJoins: true, ticketsOpened: true },
  });
  return {
    messages: aggregate._sum.messages ?? 0,
    joins: aggregate._sum.joins ?? 0,
    leaves: aggregate._sum.leaves ?? 0,
    invites: aggregate._sum.inviteJoins ?? 0,
    tickets: aggregate._sum.ticketsOpened ?? 0,
  };
}

export async function xpLeaderboard(guildId: string, limit = 10) {
  return prisma.xPRecord.findMany({ where: { guildId }, orderBy: { xp: 'desc' }, take: Math.min(limit, 100) });
}

export async function memberRank(guildId: string, discordId: string) {
  const record = await prisma.xPRecord.findUnique({ where: { guildId_discordId: { guildId, discordId } } });
  if (!record) return { record: null, rank: null };
  const higher = await prisma.xPRecord.count({ where: { guildId, xp: { gt: record.xp } } });
  return { record, rank: higher + 1 };
}

export async function voiceLeaderboard(guildId: string, limit = 10) {
  return prisma.xPRecord.findMany({
    where: { guildId, voiceSeconds: { gt: 0 } },
    orderBy: { voiceSeconds: 'desc' },
    take: Math.min(limit, 100),
  });
}

export async function guildActivityTotals(guildId: string) {
  const [messageCount, xpCount, invites, ticketCount] = await Promise.all([
    prisma.loggingEvent.count({ where: { guildId, event: 'message.create' } }),
    prisma.xPRecord.aggregate({ where: { guildId }, _sum: { messages: true, voiceSeconds: true }, _count: { _all: true } }),
    prisma.invite.aggregate({ where: { guildId }, _sum: { uses: true } }),
    prisma.ticket.count({ where: { guildId } }),
  ]);
  return { messageCount, xpCount, invites, ticketCount };
}
