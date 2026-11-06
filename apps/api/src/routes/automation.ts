/** RSS feeds, announcements, automations, custom commands and auto reactions. */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isSafeFeedUrl, normalizeFeedUrl, parseFeed } from '@irh/shared/feed';
import { enqueueJob, prisma, recordAudit } from '@irh/db';
import { requireGuild } from '../auth.js';
import { discordApi } from '../discord.js';
import { audit, notFound, pagination, requireBot } from './helpers.js';

const snowflake = z.string().regex(/^\d{15,25}$/);

export async function automationRoutes(app: FastifyInstance): Promise<void> {
  // ── RSS / video feeds ───────────────────────────────────────
  app.get('/guilds/:guildId/feeds', { preHandler: requireGuild('rss') }, async (request, reply) => {
    const guild = request.guild!;
    return reply.send({ items: await prisma.rSSFeed.findMany({ where: { guildId: guild.id }, orderBy: { createdAt: 'desc' } }) });
  });

  const feedSchema = z.object({
    url: z.string().min(1).max(500),
    type: z.enum(['rss', 'youtube', 'twitch', 'reddit']).default('rss'),
    label: z.string().max(100).optional(),
    channelId: snowflake,
    mentionRoleIds: z.array(snowflake).max(10).default([]),
    template: z.string().max(500).optional(),
    enabled: z.boolean().default(true),
  });

  app.post('/guilds/:guildId/feeds', { preHandler: requireGuild('rss') }, async (request, reply) => {
    const guild = request.guild!;
    const parsed = feedSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Invalid feed.', details: parsed.error.flatten() });
    const url = normalizeFeedUrl(parsed.data.url, parsed.data.type);
    if (!url || !isSafeFeedUrl(url)) return reply.code(400).send({ error: 'invalid_url', message: 'That feed URL cannot be used.' });
    const feed = await prisma.rSSFeed.create({
      data: {
        guildId: guild.id,
        url,
        type: parsed.data.type,
        label: parsed.data.label ?? null,
        channelId: parsed.data.channelId,
        mentionRoleIds: parsed.data.mentionRoleIds as never,
        template: parsed.data.template ?? null,
        enabled: parsed.data.enabled,
      },
    });
    await audit(request, 'feeds.create', { type: 'feed', id: feed.id, after: feed });
    return reply.code(201).send(feed);
  });

  app.patch('/guilds/:guildId/feeds/:feedId', { preHandler: requireGuild('rss') }, async (request, reply) => {
    const guild = request.guild!;
    const { feedId } = request.params as { feedId: string };
    const existing = await prisma.rSSFeed.findFirst({ where: { id: feedId, guildId: guild.id } });
    if (!existing) return notFound(reply, 'Feed not found');
    const parsed = feedSchema.partial().safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Invalid feed update.' });
    let url = existing.url;
    if (parsed.data.url) {
      const normalized = normalizeFeedUrl(parsed.data.url, parsed.data.type ?? existing.type);
      if (!normalized || !isSafeFeedUrl(normalized)) return reply.code(400).send({ error: 'invalid_url', message: 'That feed URL cannot be used.' });
      url = normalized;
    }
    const feed = await prisma.rSSFeed.update({
      where: { id: feedId },
      data: {
        ...parsed.data,
        url,
        mentionRoleIds: parsed.data.mentionRoleIds as never,
      },
    });
    await audit(request, 'feeds.update', { type: 'feed', id: feedId, after: feed });
    return reply.send(feed);
  });

  app.delete('/guilds/:guildId/feeds/:feedId', { preHandler: requireGuild('rss') }, async (request, reply) => {
    const guild = request.guild!;
    const { feedId } = request.params as { feedId: string };
    await prisma.rSSFeed.deleteMany({ where: { id: feedId, guildId: guild.id } });
    await audit(request, 'feeds.delete', { type: 'feed', id: feedId });
    return reply.send({ ok: true });
  });

  app.post('/guilds/:guildId/feeds/:feedId/test', { preHandler: requireGuild('rss') }, async (request, reply) => {
    const guild = request.guild!;
    const { feedId } = request.params as { feedId: string };
    const feed = await prisma.rSSFeed.findFirst({ where: { id: feedId, guildId: guild.id } });
    if (!feed) return notFound(reply, 'Feed not found');
    if (!isSafeFeedUrl(feed.url)) return reply.code(400).send({ error: 'invalid_url', message: 'Blocked URL.' });
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const response = await fetch(feed.url, {
        signal: controller.signal,
        headers: { 'user-agent': 'IRH-CORE/1.0 (+feed reader)', accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
      });
      clearTimeout(timeout);
      if (!response.ok) return reply.code(502).send({ error: 'feed_error', message: `Feed responded with HTTP ${response.status}.` });
      const body = await response.text();
      const parsed = parseFeed(body);
      await prisma.rSSFeed.update({ where: { id: feed.id }, data: { lastError: null, errorCount: 0 } });
      return reply.send({ ok: true, title: parsed.title, entries: parsed.entries.slice(0, 5) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Feed request failed';
      await prisma.rSSFeed.update({ where: { id: feed.id }, data: { lastError: message.slice(0, 300), errorCount: { increment: 1 } } });
      return reply.code(502).send({ error: 'feed_error', message });
    }
  });

  app.post('/guilds/:guildId/feeds/check-all', { preHandler: requireGuild('rss') }, async (request, reply) => {
    const guild = request.guild!;
    await enqueueJob({ type: 'feed.poll', guildId: guild.id, payload: { force: true }, dedupeKey: `feed.poll:${guild.id}:${Date.now()}` });
    return reply.send({ ok: true, queued: true });
  });

  // ── announcements ───────────────────────────────────────────
  app.get('/guilds/:guildId/announcements', { preHandler: requireGuild('announcements') }, async (request, reply) => {
    const guild = request.guild!;
    return reply.send({ items: await prisma.announcement.findMany({ where: { guildId: guild.id }, orderBy: { createdAt: 'desc' } }) });
  });

  const announcementSchema = z.object({
    channelId: snowflake,
    title: z.string().max(200).optional(),
    body: z.string().min(1).max(4000),
    mentionRoleIds: z.array(snowflake).max(10).default([]),
    recurrence: z.enum(['once', 'hourly', 'daily', 'weekly', 'monthly']).default('once'),
    cron: z.string().max(100).optional(),
    nextRunAt: z.string().datetime().optional(),
    enabled: z.boolean().default(true),
    embed: z
      .object({
        title: z.string().max(200).optional(),
        description: z.string().max(4000).optional(),
        color: z.number().int().min(0).max(0xffffff).optional(),
        image: z.string().url().optional(),
        thumbnail: z.string().url().optional(),
      })
      .optional(),
  });

  app.post('/guilds/:guildId/announcements', { preHandler: requireGuild('announcements') }, async (request, reply) => {
    const guild = request.guild!;
    const parsed = announcementSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Invalid announcement.', details: parsed.error.flatten() });
    const announcement = await prisma.announcement.create({
      data: {
        guildId: guild.id,
        channelId: parsed.data.channelId,
        title: parsed.data.title ?? null,
        body: parsed.data.body,
        embed: (parsed.data.embed ?? null) as never,
        mentionRoleIds: parsed.data.mentionRoleIds as never,
        recurrence: parsed.data.recurrence,
        cron: parsed.data.cron ?? null,
        nextRunAt: parsed.data.nextRunAt ? new Date(parsed.data.nextRunAt) : null,
        enabled: parsed.data.enabled,
        createdById: request.auth!.user.discordId,
      },
    });
    await audit(request, 'announcements.create', { type: 'announcement', id: announcement.id });
    return reply.code(201).send(announcement);
  });

  app.patch('/guilds/:guildId/announcements/:announcementId', { preHandler: requireGuild('announcements') }, async (request, reply) => {
    const guild = request.guild!;
    const { announcementId } = request.params as { announcementId: string };
    const existing = await prisma.announcement.findFirst({ where: { id: announcementId, guildId: guild.id } });
    if (!existing) return notFound(reply, 'Announcement not found');
    const parsed = announcementSchema.partial().safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Invalid announcement update.' });
    const updated = await prisma.announcement.update({
      where: { id: announcementId },
      data: {
        ...parsed.data,
        mentionRoleIds: parsed.data.mentionRoleIds as never,
        embed: (parsed.data.embed ?? undefined) as never,
        nextRunAt: parsed.data.nextRunAt ? new Date(parsed.data.nextRunAt) : undefined,
      },
    });
    await audit(request, 'announcements.update', { type: 'announcement', id: announcementId });
    return reply.send(updated);
  });

  app.delete('/guilds/:guildId/announcements/:announcementId', { preHandler: requireGuild('announcements') }, async (request, reply) => {
    const guild = request.guild!;
    const { announcementId } = request.params as { announcementId: string };
    await prisma.announcement.deleteMany({ where: { id: announcementId, guildId: guild.id } });
    await audit(request, 'announcements.delete', { type: 'announcement', id: announcementId });
    return reply.send({ ok: true });
  });

  app.post('/guilds/:guildId/announcements/:announcementId/send', { preHandler: requireGuild('announcements') }, async (request, reply) => {
    const guild = request.guild!;
    if (requireBot(reply, guild.botPresent)) return;
    const { announcementId } = request.params as { announcementId: string };
    const announcement = await prisma.announcement.findFirst({ where: { id: announcementId, guildId: guild.id } });
    if (!announcement) return notFound(reply, 'Announcement not found');
    const roles = (announcement.mentionRoleIds as string[]) ?? [];
    const embed = announcement.embed as { title?: string; description?: string; color?: number; image?: string } | null;
    const content = roles.length ? roles.map((roleId) => `<@&${roleId}>`).join(' ') : undefined;
    const message = await discordApi.createMessage(announcement.channelId, {
      content,
      embeds: [
        {
          title: embed?.title ?? announcement.title ?? 'Announcement',
          description: embed?.description ?? announcement.body,
          color: embed?.color ?? 0x5865f2,
          ...(embed?.image ? { image: { url: embed.image } } : {}),
          timestamp: new Date().toISOString(),
        },
      ],
      allowed_mentions: { parse: [], roles },
    });
    await prisma.announcement.update({ where: { id: announcement.id }, data: { lastRunAt: new Date() } });
    await prisma.loggingEvent.create({
      data: {
        guildId: guild.id,
        event: 'announcement.sent',
        source: 'api',
        executorId: request.auth!.user.discordId,
        channelId: announcement.channelId,
        messageId: message.id,
        summary: `Announcement sent to <#${announcement.channelId}>`,
      },
    });
    await audit(request, 'announcements.send', { type: 'announcement', id: announcement.id });
    return reply.send({ ok: true, messageId: message.id });
  });

  // ── automations ─────────────────────────────────────────────
  app.get('/guilds/:guildId/automations', { preHandler: requireGuild('automations') }, async (request, reply) => {
    const guild = request.guild!;
    return reply.send({ items: await prisma.automationWorkflow.findMany({ where: { guildId: guild.id }, orderBy: { createdAt: 'desc' } }) });
  });

  const automationSchema = z.object({
    name: z.string().min(1).max(80),
    trigger: z.enum(['member.join', 'member.leave', 'message.create', 'ticket.create', 'level.up', 'reaction.add']),
    conditions: z
      .array(z.object({ field: z.string().max(50), operator: z.enum(['equals', 'contains', 'greater', 'less', 'has_role']), value: z.string().max(200) }))
      .max(10)
      .default([]),
    actions: z
      .array(
        z.object({
          type: z.enum(['add_role', 'remove_role', 'send_message', 'dm_user', 'delete_message', 'log', 'timeout']),
          value: z.string().max(500).optional(),
          durationMs: z.number().int().min(0).max(86_400_000).optional(),
        }),
      )
      .min(1)
      .max(10),
    enabled: z.boolean().default(true),
  });

  app.post('/guilds/:guildId/automations', { preHandler: requireGuild('automations') }, async (request, reply) => {
    const guild = request.guild!;
    const parsed = automationSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Invalid automation.', details: parsed.error.flatten() });
    const existing = await prisma.automationWorkflow.count({ where: { guildId: guild.id } });
    if (existing >= 100) return reply.code(409).send({ error: 'limit_reached', message: 'Workflow limit reached.' });
    const workflow = await prisma.automationWorkflow.create({
      data: {
        guildId: guild.id,
        name: parsed.data.name,
        trigger: parsed.data.trigger,
        conditions: parsed.data.conditions as never,
        actions: parsed.data.actions as never,
        enabled: parsed.data.enabled,
      },
    });
    await audit(request, 'automations.create', { type: 'workflow', id: workflow.id });
    return reply.code(201).send(workflow);
  });

  app.patch('/guilds/:guildId/automations/:workflowId', { preHandler: requireGuild('automations') }, async (request, reply) => {
    const guild = request.guild!;
    const { workflowId } = request.params as { workflowId: string };
    const existing = await prisma.automationWorkflow.findFirst({ where: { id: workflowId, guildId: guild.id } });
    if (!existing) return notFound(reply, 'Workflow not found');
    const parsed = automationSchema.partial().safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Invalid workflow update.' });
    const workflow = await prisma.automationWorkflow.update({
      where: { id: workflowId },
      data: { ...parsed.data, conditions: parsed.data.conditions as never, actions: parsed.data.actions as never },
    });
    await audit(request, 'automations.update', { type: 'workflow', id: workflowId });
    return reply.send(workflow);
  });

  app.delete('/guilds/:guildId/automations/:workflowId', { preHandler: requireGuild('automations') }, async (request, reply) => {
    const guild = request.guild!;
    const { workflowId } = request.params as { workflowId: string };
    await prisma.automationWorkflow.deleteMany({ where: { id: workflowId, guildId: guild.id } });
    await audit(request, 'automations.delete', { type: 'workflow', id: workflowId });
    return reply.send({ ok: true });
  });

  app.post('/guilds/:guildId/automations/:workflowId/run', { preHandler: requireGuild('automations') }, async (request, reply) => {
    const guild = request.guild!;
    const { workflowId } = request.params as { workflowId: string };
    await enqueueJob({ type: 'automation.run', guildId: guild.id, payload: { workflowId, test: true }, dedupeKey: `automation.run:${workflowId}:${Date.now()}` });
    return reply.send({ ok: true, queued: true });
  });

  // ── custom commands ─────────────────────────────────────────
  app.get('/guilds/:guildId/custom-commands', { preHandler: requireGuild('customcommands') }, async (request, reply) => {
    const guild = request.guild!;
    return reply.send({ items: await prisma.customCommand.findMany({ where: { guildId: guild.id }, orderBy: { name: 'asc' } }) });
  });

  const commandSchema = z.object({
    name: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[a-z0-9_-]+$/i, 'Use letters, numbers, dashes or underscores'),
    description: z.string().max(200).optional(),
    response: z.string().min(1).max(2000),
    allowedRoleIds: z.array(snowflake).max(10).default([]),
    cooldownSec: z.number().int().min(0).max(3600).default(3),
    enabled: z.boolean().default(true),
  });

  app.post('/guilds/:guildId/custom-commands', { preHandler: requireGuild('customcommands') }, async (request, reply) => {
    const guild = request.guild!;
    const parsed = commandSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Invalid custom command.', details: parsed.error.flatten() });
    const duplicate = await prisma.customCommand.findUnique({ where: { guildId_name: { guildId: guild.id, name: parsed.data.name.toLowerCase() } } });
    if (duplicate) return reply.code(409).send({ error: 'duplicate', message: 'A command with that name already exists.' });
    const command = await prisma.customCommand.create({
      data: {
        guildId: guild.id,
        name: parsed.data.name.toLowerCase(),
        description: parsed.data.description ?? null,
        response: parsed.data.response,
        allowedRoleIds: parsed.data.allowedRoleIds as never,
        cooldownSec: parsed.data.cooldownSec,
        enabled: parsed.data.enabled,
      },
    });
    await audit(request, 'customcommands.create', { type: 'custom_command', id: command.id });
    return reply.code(201).send(command);
  });

  app.patch('/guilds/:guildId/custom-commands/:commandId', { preHandler: requireGuild('customcommands') }, async (request, reply) => {
    const guild = request.guild!;
    const { commandId } = request.params as { commandId: string };
    const existing = await prisma.customCommand.findFirst({ where: { id: commandId, guildId: guild.id } });
    if (!existing) return notFound(reply, 'Command not found');
    const parsed = commandSchema.partial().safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Invalid command update.', details: parsed.error.flatten() });
    const command = await prisma.customCommand.update({
      where: { id: commandId },
      data: { ...parsed.data, name: parsed.data.name?.toLowerCase(), allowedRoleIds: parsed.data.allowedRoleIds as never },
    });
    await audit(request, 'customcommands.update', { type: 'custom_command', id: commandId });
    return reply.send(command);
  });

  app.delete('/guilds/:guildId/custom-commands/:commandId', { preHandler: requireGuild('customcommands') }, async (request, reply) => {
    const guild = request.guild!;
    const { commandId } = request.params as { commandId: string };
    await prisma.customCommand.deleteMany({ where: { id: commandId, guildId: guild.id } });
    await audit(request, 'customcommands.delete', { type: 'custom_command', id: commandId });
    return reply.send({ ok: true });
  });

  // ── auto reactions ──────────────────────────────────────────
  app.get('/guilds/:guildId/auto-reactions', { preHandler: requireGuild('autoreactions') }, async (request, reply) => {
    const guild = request.guild!;
    return reply.send({ items: await prisma.autoReactionRule.findMany({ where: { guildId: guild.id }, orderBy: { createdAt: 'desc' } }) });
  });

  const reactionSchema = z.object({
    triggerType: z.enum(['keyword', 'regex', 'all']).default('keyword'),
    pattern: z.string().max(200).default(''),
    emojis: z.array(z.string().min(1).max(100)).min(1).max(10),
    channelIds: z.array(snowflake).max(25).default([]),
    ignoreBots: z.boolean().default(true),
    enabled: z.boolean().default(true),
  });

  app.post('/guilds/:guildId/auto-reactions', { preHandler: requireGuild('autoreactions') }, async (request, reply) => {
    const guild = request.guild!;
    const parsed = reactionSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Invalid auto reaction rule.', details: parsed.error.flatten() });
    if (parsed.data.triggerType === 'regex') {
      try {
        new RegExp(parsed.data.pattern);
      } catch {
        return reply.code(400).send({ error: 'invalid_regex', message: 'That regular expression is invalid.' });
      }
    }
    const rule = await prisma.autoReactionRule.create({
      data: {
        guildId: guild.id,
        triggerType: parsed.data.triggerType,
        pattern: parsed.data.pattern,
        emojis: parsed.data.emojis as never,
        channelIds: parsed.data.channelIds as never,
        ignoreBots: parsed.data.ignoreBots,
        enabled: parsed.data.enabled,
      },
    });
    await audit(request, 'autoreactions.create', { type: 'auto_reaction', id: rule.id });
    return reply.code(201).send(rule);
  });

  app.patch('/guilds/:guildId/auto-reactions/:ruleId', { preHandler: requireGuild('autoreactions') }, async (request, reply) => {
    const guild = request.guild!;
    const { ruleId } = request.params as { ruleId: string };
    const existing = await prisma.autoReactionRule.findFirst({ where: { id: ruleId, guildId: guild.id } });
    if (!existing) return notFound(reply, 'Rule not found');
    const parsed = reactionSchema.partial().safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Invalid rule update.' });
    const rule = await prisma.autoReactionRule.update({
      where: { id: ruleId },
      data: { ...parsed.data, emojis: parsed.data.emojis as never, channelIds: parsed.data.channelIds as never },
    });
    await audit(request, 'autoreactions.update', { type: 'auto_reaction', id: ruleId });
    return reply.send(rule);
  });

  app.delete('/guilds/:guildId/auto-reactions/:ruleId', { preHandler: requireGuild('autoreactions') }, async (request, reply) => {
    const guild = request.guild!;
    const { ruleId } = request.params as { ruleId: string };
    await prisma.autoReactionRule.deleteMany({ where: { id: ruleId, guildId: guild.id } });
    await audit(request, 'autoreactions.delete', { type: 'auto_reaction', id: ruleId });
    return reply.send({ ok: true });
  });

  // ── autoresponders ──────────────────────────────────────────
  app.get('/guilds/:guildId/autoresponders', { preHandler: requireGuild('customcommands') }, async (request, reply) => {
    const guild = request.guild!;
    return reply.send({ items: await prisma.autoResponder.findMany({ where: { guildId: guild.id }, orderBy: { createdAt: 'desc' } }) });
  });

  app.post('/guilds/:guildId/autoresponders', { preHandler: requireGuild('customcommands') }, async (request, reply) => {
    const guild = request.guild!;
    const parsed = z
      .object({
        trigger: z.string().min(1).max(200),
        matchType: z.enum(['contains', 'exact', 'prefix']).default('contains'),
        response: z.string().min(1).max(2000),
        reply: z.boolean().default(true),
        enabled: z.boolean().default(true),
      })
      .safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Invalid auto responder.' });
    const responder = await prisma.autoResponder.create({ data: { guildId: guild.id, ...parsed.data } });
    await audit(request, 'autoresponders.create', { type: 'auto_responder', id: responder.id });
    return reply.code(201).send(responder);
  });

  app.delete('/guilds/:guildId/autoresponders/:responderId', { preHandler: requireGuild('customcommands') }, async (request, reply) => {
    const guild = request.guild!;
    const { responderId } = request.params as { responderId: string };
    await prisma.autoResponder.deleteMany({ where: { id: responderId, guildId: guild.id } });
    await audit(request, 'autoresponders.delete', { type: 'auto_responder', id: responderId });
    return reply.send({ ok: true });
  });

  // ── counter channels ────────────────────────────────────────
  app.get('/guilds/:guildId/counters', { preHandler: requireGuild('statistics') }, async (request, reply) => {
    const guild = request.guild!;
    return reply.send({ items: await prisma.counterChannel.findMany({ where: { guildId: guild.id } }) });
  });

  app.put('/guilds/:guildId/counters', { preHandler: requireGuild('statistics') }, async (request, reply) => {
    const guild = request.guild!;
    const parsed = z
      .object({
        items: z
          .array(
            z.object({
              channelId: snowflake,
              type: z.enum(['members', 'online', 'boosts', 'messages', 'tickets', 'invites']),
              template: z.string().min(1).max(100),
              enabled: z.boolean().default(true),
            }),
          )
          .max(10),
      })
      .safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Invalid counters.', details: parsed.error.flatten() });
    await prisma.$transaction([
      prisma.counterChannel.deleteMany({ where: { guildId: guild.id } }),
      ...parsed.data.items.map((counter) =>
        prisma.counterChannel.create({
          data: { guildId: guild.id, channelId: counter.channelId, type: counter.type, template: counter.template, enabled: counter.enabled },
        }),
      ),
    ]);
    await recordAudit({ guildId: guild.id, actorId: request.auth!.user.discordId, action: 'counters.update', targetType: 'counters' });
    await enqueueJob({ type: 'counter.update', guildId: guild.id, payload: {}, dedupeKey: `counter:${guild.id}` });
    return reply.send({ ok: true });
  });

  void pagination;
}
