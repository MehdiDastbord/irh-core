/** Guild-scoped endpoints: settings, overview, resources, logs, audit. */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LOG_EVENTS, moduleDefaults, MODULES } from '@irh/shared';
import {
  getAllSettings as readAllSettings,
  getModuleSettings,
  saveModuleSettings,
  guildOverview,
  listAudit,
  prisma,
  purgeOldLogs,
  growthSeries,
  activityTotals,
  xpLeaderboard,
  voiceLeaderboard,
  guildLogStats,
  moderationStats,
  ticketStats,
  recordAudit,
} from '@irh/db';
import { requireGuild } from '../auth.js';
import { discordApi } from '../discord.js';
import { broadcast } from '../realtime.js';
import { audit, notFound, pagination } from './helpers.js';

export async function guildRoutes(app: FastifyInstance): Promise<void> {
  // ── guild list ──────────────────────────────────────────────
  app.get('/guilds', { preHandler: requireGuild() }, async (request, reply) => {
    const auth = request.auth!;
    const internal = await prisma.guild.findMany({ where: { discordId: { in: auth.cachedGuilds.map((guild) => guild.id) } } });
    const MANAGE_GUILD = 1n << 5n;
    const ADMINISTRATOR = 1n << 3n;
    const items = auth.cachedGuilds
      .filter((guild) => {
        if (guild.owner) return true;
        try {
          const permissions = BigInt(guild.permissions);
          return (
            (permissions & ADMINISTRATOR) === ADMINISTRATOR ||
            (permissions & MANAGE_GUILD) === MANAGE_GUILD ||
            auth.user && false
          );
        } catch {
          return false;
        }
      })
      .map((guild) => {
        const record = internal.find((row) => row.discordId === guild.id);
        return {
          id: guild.id,
          name: record?.name ?? guild.name,
          icon: record?.icon ?? guild.icon,
          owner: guild.owner,
          botPresent: Boolean(record && record.botJoinedAt.getTime() > 0),
          accessLevel: guild.owner ? 'owner' : 'manage_guild',
          memberCount: record?.memberCount ?? 0,
        };
      })
      .sort((a, b) => Number(b.botPresent) - Number(a.botPresent) || a.name.localeCompare(b.name));
    if (request.auth && request.auth.user) {
      // owner/admin-role access is resolved per guild on request
    }
    return reply.send({ items });
  });

  // ── overview ────────────────────────────────────────────────
  app.get('/guilds/:guildId/overview', { preHandler: requireGuild() }, async (request, reply) => {
    const guild = request.guild!;
    const overview = await guildOverview(guild.id);
    return reply.send({ guild, ...overview });
  });

  // ── settings ────────────────────────────────────────────────
  app.get('/guilds/:guildId/settings', { preHandler: requireGuild() }, async (request, reply) => {
    const guild = request.guild!;
    return reply.send({ settings: await readAllSettings(guild.id) });
  });

  app.get('/guilds/:guildId/settings/:module', { preHandler: requireGuild() }, async (request, reply) => {
    const guild = request.guild!;
    const { module } = request.params as { module: string };
    if (!MODULES.some((candidate) => candidate.id === module)) return notFound(reply, 'Unknown module');
    const settings = await getModuleSettings(guild.id, module);
    return reply.send({ module, settings, defaults: moduleDefaults(module) });
  });

  app.patch('/guilds/:guildId/settings/:module', { preHandler: requireGuild() }, async (request, reply) => {
    const guild = request.guild!;
    const { module } = request.params as { module: string };
    if (!MODULES.some((candidate) => candidate.id === module)) return notFound(reply, 'Unknown module');
    const result = await saveModuleSettings(guild.id, module, request.body ?? {}, { actorId: request.auth!.user.discordId });
    if (!result.ok) {
      return reply.code(422).send({ error: 'validation_failed', message: 'Some settings are invalid.', details: result.errors });
    }
    await audit(request, 'settings.update', { type: 'module', id: module, after: result.data });
    broadcast({ type: 'settings.updated', guildId: guild.discordId, payload: { module } });
    return reply.send({ ok: true, settings: result.data });
  });

  app.put('/guilds/:guildId/settings/:module', { preHandler: requireGuild() }, async (request, reply) => {
    const guild = request.guild!;
    const { module } = request.params as { module: string };
    if (!MODULES.some((candidate) => candidate.id === module)) return notFound(reply, 'Unknown module');
    const result = await saveModuleSettings(guild.id, module, request.body ?? {}, {
      actorId: request.auth!.user.discordId,
      mode: 'replace',
    });
    if (!result.ok) return reply.code(422).send({ error: 'validation_failed', message: 'Some settings are invalid.', details: result.errors });
    await audit(request, 'settings.replace', { type: 'module', id: module, after: result.data });
    broadcast({ type: 'settings.updated', guildId: guild.discordId, payload: { module } });
    return reply.send({ ok: true, settings: result.data });
  });

  // ── Discord resources for pickers ───────────────────────────
  app.get('/guilds/:guildId/resources', { preHandler: requireGuild() }, async (request, reply) => {
    const guild = request.guild!;
    if (!guild.botPresent) {
      return reply.send({
        botPresent: false,
        channels: [],
        roles: [],
        emojis: [],
        stickers: [],
        members: [],
        message: 'Invite IRH CORE to load channels and roles.',
      });
    }
    const [channels, roles, emojis, stickers] = await Promise.all([
      discordApi.guildChannels(guild.discordId).catch(() => []),
      discordApi.guildRoles(guild.discordId).catch(() => []),
      discordApi.guildEmojis(guild.discordId).catch(() => []),
      discordApi.guildStickers(guild.discordId).catch(() => []),
    ]);
    return reply.send({
      botPresent: true,
      channels: channels.map((channel) => ({ id: channel.id, name: channel.name, type: channel.type, parentId: channel.parent_id })),
      roles: roles
        .map((role) => ({ id: role.id, name: role.name, color: role.color, position: role.position, managed: role.managed }))
        .sort((a, b) => b.position - a.position),
      emojis,
      stickers,
      members: [],
    });
  });

  // ── audit history ───────────────────────────────────────────
  app.get('/guilds/:guildId/audit', { preHandler: requireGuild() }, async (request, reply) => {
    const guild = request.guild!;
    const { page, pageSize, search } = pagination(request);
    const result = await listAudit(guild.id, { page, pageSize, action: search });
    return reply.send(result);
  });

  // ── statistics ──────────────────────────────────────────────
  app.get('/guilds/:guildId/stats', { preHandler: requireGuild() }, async (request, reply) => {
    const guild = request.guild!;
    const query = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(request.query ?? {});
    const [growth, activity, moderation, tickets, logs, xp, voice] = await Promise.all([
      growthSeries(guild.id, query.days),
      activityTotals(guild.id, 7),
      moderationStats(guild.id),
      ticketStats(guild.id),
      guildLogStats(guild.id),
      xpLeaderboard(guild.id, 10),
      voiceLeaderboard(guild.id, 10),
    ]);
    return reply.send({ growth, activity, moderation, tickets, logs, xp, voice });
  });

  // ── logging configuration ───────────────────────────────────
  app.get('/guilds/:guildId/logging', { preHandler: requireGuild() }, async (request, reply) => {
    const guild = request.guild!;
    const rows = await prisma.loggingConfiguration.findMany({ where: { guildId: guild.id } });
    const configured = new Map(rows.map((row) => [row.event, row]));
    return reply.send({
      events: LOG_EVENTS.map((event) => {
        const row = configured.get(event.key);
        return {
          ...event,
          enabled: row?.enabled ?? false,
          channelIds: (row?.channelIds as string[] | null) ?? [],
          color: row?.color ?? null,
          ignoreRoleIds: (row?.ignoreRoleIds as string[] | null) ?? [],
          ignoreChannelIds: (row?.ignoreChannelIds as string[] | null) ?? [],
          configured: Boolean(row),
        };
      }),
    });
  });

  app.patch('/guilds/:guildId/logging/:event', { preHandler: requireGuild() }, async (request, reply) => {
    const guild = request.guild!;
    const { event } = request.params as { event: string };
    if (!LOG_EVENTS.some((entry) => entry.key === event)) return notFound(reply, 'Unknown log event');
    const body = z
      .object({
        enabled: z.boolean().optional(),
        channelIds: z.array(z.string().regex(/^\d{15,25}$/)).max(10).optional(),
        color: z.number().int().min(0).max(0xffffff).nullable().optional(),
        ignoreRoleIds: z.array(z.string()).max(50).optional(),
        ignoreChannelIds: z.array(z.string()).max(50).optional(),
      })
      .safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: 'Invalid logging configuration.', details: body.error.flatten() });
    const existing = await prisma.loggingConfiguration.findUnique({ where: { guildId_event: { guildId: guild.id, event } } });
    const row = await prisma.loggingConfiguration.upsert({
      where: { guildId_event: { guildId: guild.id, event } },
      create: {
        guildId: guild.id,
        event,
        enabled: body.data.enabled ?? true,
        channelIds: (body.data.channelIds ?? []) as never,
        color: body.data.color ?? null,
        ignoreRoleIds: (body.data.ignoreRoleIds ?? []) as never,
        ignoreChannelIds: (body.data.ignoreChannelIds ?? []) as never,
      },
      update: {
        ...(body.data.enabled === undefined ? {} : { enabled: body.data.enabled }),
        ...(body.data.channelIds === undefined ? {} : { channelIds: body.data.channelIds as never }),
        ...(body.data.color === undefined ? {} : { color: body.data.color }),
        ...(body.data.ignoreRoleIds === undefined ? {} : { ignoreRoleIds: body.data.ignoreRoleIds as never }),
        ...(body.data.ignoreChannelIds === undefined ? {} : { ignoreChannelIds: body.data.ignoreChannelIds as never }),
      },
    });
    await recordAudit({
      guildId: guild.id,
      actorId: request.auth!.user.discordId,
      action: 'logging.update',
      targetType: 'log_event',
      targetId: event,
      before: existing ?? undefined,
      after: row,
    });
    broadcast({ type: 'logging.updated', guildId: guild.discordId, payload: { event } });
    return reply.send({ ok: true });
  });

  app.post('/guilds/:guildId/logging/bulk', { preHandler: requireGuild() }, async (request, reply) => {
    const guild = request.guild!;
    const body = z
      .object({
        events: z.array(z.string()).max(200),
        enabled: z.boolean(),
        channelIds: z.array(z.string().regex(/^\d{15,25}$/)).max(10).optional(),
      })
      .safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: 'Invalid bulk update.' });
    const valid = body.data.events.filter((event) => LOG_EVENTS.some((entry) => entry.key === event));
    await prisma.$transaction(
      valid.map((event) =>
        prisma.loggingConfiguration.upsert({
          where: { guildId_event: { guildId: guild.id, event } },
          create: {
            guildId: guild.id,
            event,
            enabled: body.data.enabled,
            channelIds: (body.data.channelIds ?? []) as never,
            ignoreRoleIds: [] as never,
            ignoreChannelIds: [] as never,
          },
          update: {
            enabled: body.data.enabled,
            ...(body.data.channelIds ? { channelIds: body.data.channelIds as never } : {}),
          },
        }),
      ),
    );
    await audit(request, 'logging.bulk', { type: 'log_event', id: `${valid.length} events` });
    return reply.send({ ok: true, updated: valid.length });
  });

  app.get('/guilds/:guildId/logs', { preHandler: requireGuild() }, async (request, reply) => {
    const guild = request.guild!;
    const { page, pageSize, search } = pagination(request);
    const query = z
      .object({ event: z.string().optional(), executorId: z.string().optional(), targetId: z.string().optional() })
      .parse(request.query ?? {});
    const where = {
      guildId: guild.id,
      ...(query.event ? { event: query.event } : {}),
      ...(query.executorId ? { executorId: query.executorId } : {}),
      ...(query.targetId ? { targetId: query.targetId } : {}),
      ...(search ? { summary: { contains: search } } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.loggingEvent.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      prisma.loggingEvent.count({ where }),
    ]);
    return reply.send({ items, total, page, pageSize });
  });

  app.get('/guilds/:guildId/logs/export', { preHandler: requireGuild() }, async (request, reply) => {
    const guild = request.guild!;
    const query = z.object({ event: z.string().optional(), days: z.coerce.number().int().min(1).max(365).default(30) }).parse(request.query ?? {});
    const rows = await prisma.loggingEvent.findMany({
      where: { guildId: guild.id, createdAt: { gte: new Date(Date.now() - query.days * 86_400_000) }, ...(query.event ? { event: query.event } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 5000,
    });
    const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const header = 'timestamp,event,source,executor_id,target_id,channel_id,summary';
    const csv = [
      header,
      ...rows.map((row) =>
        [row.createdAt.toISOString(), row.event, row.source, row.executorId, row.targetId, row.channelId, row.summary].map(escape).join(','),
      ),
    ].join('\n');
    await recordAudit({ guildId: guild.id, actorId: request.auth!.user.discordId, action: 'logs.export', targetType: 'logs' });
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="irh-logs-${guild.discordId}-${Date.now()}.csv"`)
      .send(csv);
  });

  app.post('/guilds/:guildId/logs/purge', { preHandler: requireGuild() }, async (request, reply) => {
    const guild = request.guild!;
    const settings = await getModuleSettings<{ retentionDays: number }>(guild.id, 'logging');
    const removed = await purgeOldLogs(guild.id, settings.retentionDays);
    await audit(request, 'logs.purge', { type: 'logs', id: String(removed) });
    return reply.send({ ok: true, removed });
  });

  app.get('/guilds/:guildId/settings/summary', { preHandler: requireGuild() }, async (request, reply) => {
    const guild = request.guild!;
    return reply.send({ settings: await readAllSettings(guild.id) });
  });
}
