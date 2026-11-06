/** System health, jobs, backups, integrations, emoji manager and realtime tickets. */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createBackup,
  decryptSecret,
  encryptSecret,
  enqueueJob,
  jobStats,
  prisma,
  purgeExpiredBackups,
  recordAudit,
  restoreBackup,
} from '@irh/db';
import { requireAuth, requireGuild } from '../auth.js';
import { discordApi } from '../discord.js';
import { connectionCount, issueTicket } from '../realtime.js';
import { audit, notFound, pagination, requireBot } from './helpers.js';

const snowflake = z.string().regex(/^\d{15,25}$/);

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  // ── health / status ─────────────────────────────────────────
  app.get('/system/health', async (_request, reply) => {
    const started = Date.now();
    let database = false;
    try {
      await prisma.$queryRaw`SELECT 1`;
      database = true;
    } catch {
      database = false;
    }
    const heartbeat = await prisma.systemEvent.findFirst({ where: { scope: 'bot', level: 'heartbeat' }, orderBy: { createdAt: 'desc' } });
    return reply.code(database ? 200 : 503).send({
      status: database ? 'ok' : 'degraded',
      database,
      dbLatencyMs: Date.now() - started,
      redis: app.hasDecorator('redis') ? Boolean(app.redis) : false,
      bot: heartbeat
        ? { online: Date.now() - heartbeat.createdAt.getTime() < 90_000, lastSeen: heartbeat.createdAt, meta: heartbeat.meta }
        : { online: false, lastSeen: null },
      realtimeClients: connectionCount(),
      uptimeSeconds: Math.round(process.uptime()),
      version: process.env.npm_package_version ?? '1.0.0',
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/system/status', { preHandler: requireAuth }, async (_request, reply) => {
    const [users, guilds, sessions, logs, jobs, backups, heartbeat] = await Promise.all([
      prisma.user.count(),
      prisma.guild.count(),
      prisma.session.count({ where: { expiresAt: { gt: new Date() } } }),
      prisma.loggingEvent.count(),
      jobStats(),
      prisma.backup.count(),
      prisma.systemEvent.findFirst({ where: { scope: 'bot', level: 'heartbeat' }, orderBy: { createdAt: 'desc' } }),
    ]);
    return reply.send({
      database: { connected: true, users, guilds, sessions, logs, backups },
      jobs,
      bot: heartbeat ? { online: Date.now() - heartbeat.createdAt.getTime() < 90_000, lastSeen: heartbeat.createdAt, meta: heartbeat.meta } : { online: false },
      realtimeClients: connectionCount(),
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version,
      memoryMb: Math.round(process.memoryUsage().rss / 1_048_576),
    });
  });

  app.get('/system/events', { preHandler: requireAuth }, async (request, reply) => {
    const { pageSize } = pagination(request);
    const items = await prisma.systemEvent.findMany({ where: { level: { not: 'heartbeat' } }, orderBy: { createdAt: 'desc' }, take: pageSize });
    return reply.send({ items });
  });

  // ── jobs ────────────────────────────────────────────────────
  app.get('/system/jobs', { preHandler: requireAuth }, async (request, reply) => {
    const query = z.object({ status: z.string().optional() }).parse(request.query ?? {});
    const items = await prisma.scheduledJob.findMany({
      where: query.status ? { status: query.status } : {},
      orderBy: [{ status: 'asc' }, { runAt: 'asc' }],
      take: 100,
    });
    return reply.send({ items, stats: await jobStats() });
  });

  app.post('/system/jobs/:jobId/retry', { preHandler: requireAuth }, async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const job = await prisma.scheduledJob.findUnique({ where: { id: jobId } });
    if (!job) return notFound(reply, 'Job not found');
    const updated = await prisma.scheduledJob.update({
      where: { id: jobId },
      data: { status: 'pending', runAt: new Date(), attempts: 0, lastError: null, completedAt: null },
    });
    await recordAudit({ guildId: job.guildId, actorId: request.auth!.user.discordId, action: 'jobs.retry', targetType: 'job', targetId: jobId });
    return reply.send(updated);
  });

  app.delete('/system/jobs/:jobId', { preHandler: requireAuth }, async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    await prisma.scheduledJob.updateMany({ where: { id: jobId }, data: { status: 'cancelled', completedAt: new Date() } });
    return reply.send({ ok: true });
  });

  // ── realtime ticket ─────────────────────────────────────────
  app.post('/me/ws-ticket', { preHandler: requireAuth }, async (request, reply) => {
    const guilds = await prisma.guild.findMany({
      where: { discordId: { in: request.auth!.cachedGuilds.map((guild) => guild.id) } },
      select: { discordId: true },
    });
    return reply.send({ ticket: issueTicket(request.auth!.user.discordId, guilds.map((guild) => guild.discordId)), expiresIn: 60 });
  });

  // ── backups ─────────────────────────────────────────────────
  app.get('/guilds/:guildId/backups', { preHandler: requireGuild('backups') }, async (request, reply) => {
    const guild = request.guild!;
    const items = await prisma.backup.findMany({
      where: { guildId: guild.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, sizeBytes: true, createdAt: true, restoredAt: true, createdById: true },
    });
    return reply.send({ items });
  });

  app.post('/guilds/:guildId/backups', { preHandler: requireGuild('backups') }, async (request, reply) => {
    const guild = request.guild!;
    const body = z.object({ name: z.string().min(1).max(120).optional(), includeMembers: z.boolean().optional() }).safeParse(request.body ?? {});
    const name = (body.success && body.data.name) || `Backup ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    const result = await createBackup({
      guildId: guild.id,
      name,
      createdById: request.auth!.user.discordId,
      includeMembers: body.success ? body.data.includeMembers : false,
    });
    await audit(request, 'backup.create', { type: 'backup', id: result.id });
    return reply.code(201).send(result);
  });

  app.get('/guilds/:guildId/backups/:backupId', { preHandler: requireGuild('backups') }, async (request, reply) => {
    const guild = request.guild!;
    const { backupId } = request.params as { backupId: string };
    const backup = await prisma.backup.findFirst({ where: { id: backupId, guildId: guild.id } });
    if (!backup) return notFound(reply, 'Backup not found');
    return reply.send(backup);
  });

  app.post('/guilds/:guildId/backups/:backupId/restore', { preHandler: requireGuild('backups') }, async (request, reply) => {
    const guild = request.guild!;
    const { backupId } = request.params as { backupId: string };
    try {
      const result = await restoreBackup({ guildId: guild.id, backupId, actorId: request.auth!.user.discordId });
      await audit(request, 'backup.restore', { type: 'backup', id: backupId });
      return reply.send({ ok: true, ...result });
    } catch (error) {
      return reply.code(400).send({ error: 'restore_failed', message: error instanceof Error ? error.message : 'Restore failed' });
    }
  });

  app.delete('/guilds/:guildId/backups/:backupId', { preHandler: requireGuild('backups') }, async (request, reply) => {
    const guild = request.guild!;
    const { backupId } = request.params as { backupId: string };
    await prisma.backup.deleteMany({ where: { id: backupId, guildId: guild.id } });
    await audit(request, 'backup.delete', { type: 'backup', id: backupId });
    return reply.send({ ok: true });
  });

  app.post('/guilds/:guildId/backups/retention', { preHandler: requireGuild('backups') }, async (request, reply) => {
    const guild = request.guild!;
    const body = z.object({ retentionDays: z.number().int().min(1).max(365).default(30) }).safeParse(request.body ?? {});
    const removed = await purgeExpiredBackups(guild.id, body.success ? body.data.retentionDays : 30);
    return reply.send({ ok: true, removed });
  });

  // ── integrations (secrets encrypted at rest) ─────────────────
  app.get('/guilds/:guildId/integrations', { preHandler: requireGuild('integrations') }, async (request, reply) => {
    const guild = request.guild!;
    const rows = await prisma.integrationCredential.findMany({ where: { OR: [{ guildId: guild.id }, { guildId: null }] } });
    return reply.send({
      items: rows.map((row) => ({
        id: row.id,
        provider: row.provider,
        status: row.status,
        scope: row.guildId ? 'guild' : 'global',
        updatedAt: row.updatedAt,
      })),
      env: {
        youtubeApiKey: Boolean(process.env.YOUTUBE_API_KEY),
        twitch: Boolean(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET),
      },
    });
  });

  app.put('/guilds/:guildId/integrations/:provider', { preHandler: requireGuild('integrations') }, async (request, reply) => {
    const guild = request.guild!;
    const { provider } = request.params as { provider: string };
    if (!/^[a-z0-9_-]{2,40}$/.test(provider)) return reply.code(400).send({ error: 'invalid_provider', message: 'Invalid provider name.' });
    const body = z.object({ secrets: z.record(z.string().min(1).max(500)), scope: z.enum(['guild', 'global']).default('guild') }).safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: 'Invalid credentials payload.' });
    if (!process.env.ENCRYPTION_KEY) {
      return reply.code(503).send({ error: 'encryption_unavailable', message: 'Set ENCRYPTION_KEY before storing integration credentials.' });
    }
    const encrypted = encryptSecret(JSON.stringify(body.data.secrets));
    const guildId = body.data.scope === 'global' ? null : guild.id;
    const record = await prisma.integrationCredential.upsert({
      where: { guildId_provider: { guildId: guildId as never, provider } },
      create: { guildId, provider, encrypted, status: 'configured' },
      update: { encrypted, status: 'configured' },
    });
    await recordAudit({ guildId: guild.id, actorId: request.auth!.user.discordId, action: 'integrations.update', targetType: 'integration', targetId: provider });
    return reply.send({ ok: true, provider: record.provider, updatedAt: record.updatedAt });
  });

  app.delete('/guilds/:guildId/integrations/:provider', { preHandler: requireGuild('integrations') }, async (request, reply) => {
    const guild = request.guild!;
    const { provider } = request.params as { provider: string };
    await prisma.integrationCredential.deleteMany({ where: { guildId: guild.id, provider } });
    await recordAudit({ guildId: guild.id, actorId: request.auth!.user.discordId, action: 'integrations.delete', targetType: 'integration', targetId: provider });
    return reply.send({ ok: true });
  });

  app.post('/guilds/:guildId/integrations/:provider/verify', { preHandler: requireGuild('integrations') }, async (request, reply) => {
    const guild = request.guild!;
    const { provider } = request.params as { provider: string };
    const record = await prisma.integrationCredential.findFirst({ where: { provider, guildId: guild.id } });
    if (!record) return notFound(reply, 'Integration not configured');
    let parsed: Record<string, string>;
    try {
      parsed = JSON.parse(decryptSecret(record.encrypted)) as Record<string, string>;
    } catch {
      return reply.code(500).send({ error: 'decrypt_failed', message: 'Stored credentials could not be read. Re-enter them.' });
    }
    const keys = Object.keys(parsed);
    await prisma.integrationCredential.update({ where: { id: record.id }, data: { status: keys.length ? 'configured' : 'incomplete' } });
    return reply.send({ ok: true, provider, fields: keys });
  });

  // ── emoji manager ───────────────────────────────────────────
  app.get('/guilds/:guildId/emojis', { preHandler: requireGuild('emojis') }, async (request, reply) => {
    const guild = request.guild!;
    const items = await prisma.emojiRecord.findMany({ where: { guildId: guild.id }, orderBy: { name: 'asc' } });
    const stickers = await prisma.stickerRecord.findMany({ where: { guildId: guild.id }, orderBy: { name: 'asc' } });
    return reply.send({ items, stickers });
  });

  app.post('/guilds/:guildId/emojis/sync', { preHandler: requireGuild('emojis') }, async (request, reply) => {
    const guild = request.guild!;
    if (requireBot(reply, guild.botPresent)) return;
    const [emojis, stickers] = await Promise.all([discordApi.guildEmojis(guild.discordId), discordApi.guildStickers(guild.discordId)]);
    for (const emoji of emojis) {
      await prisma.emojiRecord.upsert({
        where: { guildId_emojiId: { guildId: guild.id, emojiId: emoji.id } },
        create: {
          guildId: guild.id,
          emojiId: emoji.id,
          name: emoji.name,
          animated: emoji.animated,
          url: `https://cdn.discordapp.com/emojis/${emoji.id}.${emoji.animated ? 'gif' : 'png'}`,
        },
        update: { name: emoji.name, animated: emoji.animated },
      });
    }
    for (const sticker of stickers) {
      await prisma.stickerRecord.upsert({
        where: { guildId_stickerId: { guildId: guild.id, stickerId: sticker.id } },
        create: { guildId: guild.id, stickerId: sticker.id, name: sticker.name, format: String(sticker.format_type) },
        update: { name: sticker.name },
      });
    }
    await recordAudit({ guildId: guild.id, actorId: request.auth!.user.discordId, action: 'emojis.sync', targetType: 'emojis' });
    return reply.send({ ok: true, emojis: emojis.length, stickers: stickers.length });
  });

  app.delete('/guilds/:guildId/emojis/:emojiId', { preHandler: requireGuild('emojis') }, async (request, reply) => {
    const guild = request.guild!;
    const { emojiId } = request.params as { emojiId: string };
    await prisma.emojiRecord.deleteMany({ where: { guildId: guild.id, emojiId } });
    await recordAudit({ guildId: guild.id, actorId: request.auth!.user.discordId, action: 'emojis.delete', targetType: 'emoji', targetId: emojiId });
    return reply.send({ ok: true });
  });

  app.get('/guilds/:guildId/emojis/export', { preHandler: requireGuild('emojis') }, async (request, reply) => {
    const guild = request.guild!;
    const [emojis, stickers] = await Promise.all([
      prisma.emojiRecord.findMany({ where: { guildId: guild.id } }),
      prisma.stickerRecord.findMany({ where: { guildId: guild.id } }),
    ]);
    const pack = {
      version: 1,
      exportedAt: new Date().toISOString(),
      guild: guild.discordId,
      emojis: emojis.map((emoji) => ({ name: emoji.name, id: emoji.emojiId, animated: emoji.animated, url: emoji.url })),
      stickers: stickers.map((sticker) => ({ name: sticker.name, id: sticker.stickerId, format: sticker.format })),
    };
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="irh-emojis-${guild.discordId}.json"`)
      .send(JSON.stringify(pack, null, 2));
  });

  app.post('/guilds/:guildId/emojis/import', { preHandler: requireGuild('emojis') }, async (request, reply) => {
    const guild = request.guild!;
    const parsed = z
      .object({
        emojis: z
          .array(z.object({ name: z.string().min(2).max(32).regex(/^[a-zA-Z0-9_]+$/), url: z.string().url().optional(), id: z.string().optional(), animated: z.boolean().optional() }))
          .max(100),
      })
      .safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Invalid emoji pack.', details: parsed.error.flatten() });
    let imported = 0;
    for (const emoji of parsed.data.emojis) {
      if (!emoji.id) continue;
      await prisma.emojiRecord.upsert({
        where: { guildId_emojiId: { guildId: guild.id, emojiId: emoji.id } },
        create: { guildId: guild.id, emojiId: emoji.id, name: emoji.name, animated: emoji.animated ?? false, url: emoji.url ?? null, addedById: request.auth!.user.discordId },
        update: { name: emoji.name },
      });
      imported += 1;
    }
    return reply.send({ ok: true, imported });
  });

  // ── integrations for outbound webhooks: test delivery ───────
  app.post('/guilds/:guildId/integrations/webhook/test', { preHandler: requireGuild('integrations') }, async (request, reply) => {
    const guild = request.guild!;
    const settings = await prisma.guildSetting.findUnique({ where: { guildId_moduleId: { guildId: guild.id, moduleId: 'integrations' } } });
    const data = (settings?.data ?? {}) as { outboundWebhookUrl?: string };
    if (!data.outboundWebhookUrl) return reply.code(400).send({ error: 'not_configured', message: 'Set an outbound webhook URL first.' });
    try {
      const response = await fetch(data.outboundWebhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'IRH-CORE/1.0' },
        body: JSON.stringify({ event: 'test', guildId: guild.discordId, ts: new Date().toISOString() }),
      });
      return reply.send({ ok: response.ok, status: response.status });
    } catch (error) {
      return reply.code(502).send({ error: 'webhook_failed', message: error instanceof Error ? error.message : 'Webhook delivery failed' });
    }
  });

  void snowflake;
  void enqueueJob;
}
