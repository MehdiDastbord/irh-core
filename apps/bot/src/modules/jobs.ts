/** Scheduled job handlers + recurring job registration. */

import type { Client } from 'discord.js';
import {
  closeCase,
  createBackup,
  enqueueJob,
  expiredActiveCases,
  expireOldWarnings,
  getModuleSettings,
  inactiveTickets,
  logger,
  prisma,
  purgeExpiredBackups,
  purgeOldLogs,
  recordSnapshot,
  requireGuildId,
} from '@irh/db';
import type { Scheduler } from '../lib/scheduler.js';
import { pollAllFeeds } from './feeds.js';
import { processDueAnnouncements, sendAnnouncement } from './announcements.js';
import { endGiveaway, startGiveaway } from './giveaways.js';
import { closeTicket } from './tickets.js';
import { runWorkflows } from './automations.js';
import { setClient } from '../lib/client-registry.js';

const log = logger.child('jobs');

interface Recurring {
  type: string;
  everyMs: number;
}

const RECURRING: Recurring[] = [
  { type: 'feed.poll', everyMs: 10 * 60_000 },
  { type: 'announcement.tick', everyMs: 60_000 },
  { type: 'stats.snapshot', everyMs: 60 * 60_000 },
  { type: 'moderation.expire', everyMs: 5 * 60_000 },
  { type: 'ticket.inactivity', everyMs: 30 * 60_000 },
  { type: 'counter.update', everyMs: 5 * 60_000 },
  { type: 'voicemaster.cleanup', everyMs: 60_000 },
  { type: 'logs.purge', everyMs: 24 * 60 * 60_000 },
  { type: 'backup.auto', everyMs: 6 * 60 * 60_000 },
];

async function scheduleNext(type: string, delayMs: number): Promise<void> {
  const dedupeKey = `recurring:${type}`;
  const existing = await prisma.scheduledJob.findUnique({ where: { dedupeKey } });
  if (existing && (existing.status === 'pending' || existing.status === 'running')) return;
  await enqueueJob({ type, dedupeKey, runAt: new Date(Date.now() + delayMs), maxAttempts: 3 });
}

async function scheduleAll(): Promise<void> {
  for (const recurring of RECURRING) {
    const dedupeKey = `recurring:${recurring.type}`;
    const existing = await prisma.scheduledJob.findUnique({ where: { dedupeKey } });
    if (!existing) {
      await enqueueJob({ type: recurring.type, dedupeKey, runAt: new Date(), maxAttempts: 3 });
      continue;
    }
    if (existing.status === 'failed' || existing.status === 'cancelled' || existing.status === 'completed') {
      await prisma.scheduledJob.update({
        where: { id: existing.id },
        data: { status: 'pending', runAt: new Date(Date.now() + recurring.everyMs), attempts: 0, lastError: null, completedAt: null },
      });
    }
  }
}

async function updateCounters(client: Client): Promise<void> {
  const counters = await prisma.counterChannel.findMany({ where: { enabled: true }, take: 200 });
  for (const counter of counters) {
    try {
      const guild = await client.guilds.fetch(await discordGuildIdFor(counter.guildId)).catch(() => null);
      if (!guild) continue;
      const value =
        counter.type === 'members'
          ? guild.memberCount
          : counter.type === 'online'
            ? guild.members.cache.filter((member) => member.presence && member.presence.status !== 'offline').size
            : counter.type === 'boosts'
              ? guild.premiumSubscriptionCount ?? 0
              : counter.type === 'messages'
                ? await prisma.xPRecord.aggregate({ where: { guildId: counter.guildId }, _sum: { messages: true } }).then((result) => result._sum.messages ?? 0)
                : counter.type === 'tickets'
                  ? await prisma.ticket.count({ where: { guildId: counter.guildId } })
                  : await prisma.inviteEvent.count({ where: { guildId: counter.guildId, type: 'join', fake: false } });
      const name = counter.template.replace(/\{value\}/g, String(value)).slice(0, 100);
      const channel = await guild.channels.fetch(counter.channelId).catch(() => null);
      if (channel && channel.name !== name && 'setName' in channel) {
        await channel.setName(name, 'IRH CORE counter').catch(() => undefined);
      }
    } catch (error) {
      log.debug('Counter update failed', { counterId: counter.id, error: String(error) });
    }
  }
}

async function discordGuildIdFor(internalGuildId: string): Promise<string> {
  const guild = await prisma.guild.findUnique({ where: { id: internalGuildId }, select: { discordId: true } });
  return guild?.discordId ?? '';
}

export function registerAllJobs(client: Client, _scheduler: Scheduler): void {
  setClient(client);

  const recurringHandler = (type: string, everyMs: number, fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
    } finally {
      await scheduleNext(type, everyMs).catch(() => undefined);
    }
  };

  import('../lib/scheduler.js').then(async ({ registerJobHandler }) => {
    registerJobHandler('giveaway.start', async (payload) => {
      await startGiveaway(client, String(payload.giveawayId));
    });

    registerJobHandler('giveaway.end', async (payload) => {
      const id = String(payload.giveawayId);
      const giveaway = await prisma.giveaway.findUnique({ where: { id } });
      if (!giveaway) return;
      if (giveaway.status === 'paused' && !payload.force) return;
      await endGiveaway(id);
    });

    registerJobHandler('giveaway.reroll', async (payload) => {
      await endGiveaway(String(payload.giveawayId), { reroll: true, rerollCount: Number(payload.count ?? 1) });
    });

    registerJobHandler('ticket.close', async (payload) => {
      const ticketId = String(payload.ticketId);
      const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
      if (!ticket) return;
      const guild = await client.guilds.fetch(await discordGuildIdFor(ticket.guildId)).catch(() => null);
      if (!guild) return;
      await closeTicket({ guild, channelId: ticket.channelId, actorId: String(payload.closedById ?? 'system'), reason: String(payload.reason ?? 'Closed') });
    });

    registerJobHandler(
      'feed.poll',
      recurringHandler('feed.poll', 10 * 60_000, () => pollAllFeeds(client)),
    );

    registerJobHandler(
      'announcement.tick',
      recurringHandler('announcement.tick', 60_000, () => processDueAnnouncements(client)),
    );

    registerJobHandler('announcement.send', async (payload) => {
      await sendAnnouncement(client, String(payload.announcementId));
    });

    registerJobHandler(
      'stats.snapshot',
      recurringHandler('stats.snapshot', 60 * 60_000, async () => {
        for (const guild of client.guilds.cache.values()) {
          const internalId = await requireGuildId(guild.id);
          const online = guild.members.cache.filter((member) => member.presence && member.presence.status !== 'offline').size;
          await recordSnapshot(internalId, {
            memberCount: guild.memberCount,
            onlineCount: online,
            boostCount: guild.premiumSubscriptionCount ?? 0,
          });
        }
      }),
    );

    registerJobHandler(
      'moderation.expire',
      recurringHandler('moderation.expire', 5 * 60_000, async () => {
        const expired = await expiredActiveCases(100);
        for (const moderationCase of expired) {
          if (moderationCase.action === 'ban') {
            const guildRecord = await prisma.guild.findUnique({ where: { id: moderationCase.guildId } });
            if (guildRecord) {
              const guild = await client.guilds.fetch(guildRecord.discordId).catch(() => null);
              await guild?.members.unban(moderationCase.targetId, 'Temporary ban expired').catch(() => undefined);
            }
          }
          if (moderationCase.action === 'timeout') {
            const guildRecord = await prisma.guild.findUnique({ where: { id: moderationCase.guildId } });
            if (guildRecord) {
              const guild = await client.guilds.fetch(guildRecord.discordId).catch(() => null);
              const member = await guild?.members.fetch(moderationCase.targetId).catch(() => null);
              await member?.timeout(null, 'Temporary timeout expired').catch(() => undefined);
            }
          }
          await closeCase(moderationCase.id);
        }
        for (const guild of client.guilds.cache.values()) {
          const internalId = await requireGuildId(guild.id);
          const settings = await getModuleSettings<{ autoExpireDays: number }>(internalId, 'moderation');
          await expireOldWarnings(internalId, settings.autoExpireDays ?? 0);
        }
      }),
    );

    registerJobHandler(
      'ticket.inactivity',
      recurringHandler('ticket.inactivity', 30 * 60_000, async () => {
        const guilds = await prisma.guild.findMany({ where: { botJoinedAt: { gt: new Date(0) } }, select: { id: true, discordId: true } });
        for (const guildRecord of guilds) {
          const settings = await getModuleSettings<{ inactiveCloseHours: number }>(guildRecord.id, 'tickets');
          if (!settings.inactiveCloseHours) continue;
          const tickets = await inactiveTickets(guildRecord.id, settings.inactiveCloseHours);
          const guild = await client.guilds.fetch(guildRecord.discordId).catch(() => null);
          if (!guild) continue;
          for (const ticket of tickets) {
            await closeTicket({ guild, channelId: ticket.channelId, actorId: client.user?.id ?? 'system', reason: 'Closed automatically after inactivity' }).catch(() => undefined);
          }
        }
      }),
    );

    registerJobHandler(
      'counter.update',
      recurringHandler('counter.update', 5 * 60_000, () => updateCounters(client)),
    );

    registerJobHandler(
      'voicemaster.cleanup',
      recurringHandler('voicemaster.cleanup', 60_000, async () => {
        const channels = await prisma.voiceMasterChannel.findMany({ take: 500 });
        for (const record of channels) {
          const guildRecord = await prisma.guild.findUnique({ where: { id: record.guildId }, select: { discordId: true } });
          if (!guildRecord) continue;
          const guild = await client.guilds.fetch(guildRecord.discordId).catch(() => null);
          const channel = await guild?.channels.fetch(record.channelId).catch(() => null);
          if (!channel || !channel.isVoiceBased()) {
            await prisma.voiceMasterChannel.delete({ where: { id: record.id } }).catch(() => undefined);
            continue;
          }
          if (channel.members.size === 0) {
            await channel.delete('Empty temporary voice channel').catch(() => undefined);
            await prisma.voiceMasterChannel.delete({ where: { id: record.id } }).catch(() => undefined);
          }
        }
      }),
    );

    registerJobHandler(
      'logs.purge',
      recurringHandler('logs.purge', 24 * 60 * 60_000, async () => {
        const guilds = await prisma.guild.findMany({ select: { id: true } });
        for (const guild of guilds) {
          const settings = await getModuleSettings<{ retentionDays: number }>(guild.id, 'logging');
          await purgeOldLogs(guild.id, settings.retentionDays ?? 90);
        }
        await prisma.auditRecord.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 180 * 86_400_000) } } }).catch(() => undefined);
      }),
    );

    registerJobHandler(
      'backup.auto',
      recurringHandler('backup.auto', 6 * 60 * 60_000, async () => {
        const guilds = await prisma.guild.findMany({ where: { botJoinedAt: { gt: new Date(0) } }, select: { id: true } });
        for (const guild of guilds) {
          const settings = await getModuleSettings<{ autoBackupEnabled: boolean; intervalHours: number; retentionDays: number }>(guild.id, 'backups');
          if (!settings.autoBackupEnabled) continue;
          const last = await prisma.backup.findFirst({ where: { guildId: guild.id }, orderBy: { createdAt: 'desc' } });
          if (last && Date.now() - last.createdAt.getTime() < settings.intervalHours * 3_600_000) continue;
          await createBackup({ guildId: guild.id, name: `Automatic backup ${new Date().toISOString().slice(0, 10)}` }).catch((error) =>
            log.warn('Automatic backup failed', { guildId: guild.id, error: String(error) }),
          );
          await purgeExpiredBackups(guild.id, settings.retentionDays ?? 30);
        }
      }),
    );

    registerJobHandler('automation.run', async (payload) => {
      const workflowId = String(payload.workflowId);
      const workflow = await prisma.automationWorkflow.findUnique({ where: { id: workflowId } });
      if (!workflow) return;
      const guildRecord = await prisma.guild.findUnique({ where: { id: workflow.guildId } });
      if (!guildRecord) return;
      const guild = await client.guilds.fetch(guildRecord.discordId).catch(() => null);
      if (!guild) return;
      await runWorkflows(workflow.trigger, { guild, extra: { test: true } });
    });

    await scheduleAll();
    log.info('Job handlers registered', { recurring: RECURRING.length });
  });
}
