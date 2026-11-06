/** Tickets, reaction roles, giveaways, invites and leveling endpoints. */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomCode } from '@irh/shared';
import {
  enqueueJob,
  prisma,
  recordAudit,
  ticketStats,
  xpLeaderboard,
  voiceLeaderboard,
  getModuleSettings,
} from '@irh/db';
import { requireGuild } from '../auth.js';
import { discordApi } from '../discord.js';
import { broadcast } from '../realtime.js';
import { audit, notFound, pagination, requireBot } from './helpers.js';

const snowflake = z.string().regex(/^\d{15,25}$/);

export async function communityRoutes(app: FastifyInstance): Promise<void> {
  // ── tickets ─────────────────────────────────────────────────
  app.get('/guilds/:guildId/tickets', { preHandler: requireGuild('tickets') }, async (request, reply) => {
    const guild = request.guild!;
    const { page, pageSize, search } = pagination(request);
    const query = z.object({ status: z.string().optional(), priority: z.string().optional() }).parse(request.query ?? {});
    const where = {
      guildId: guild.id,
      ...(query.status ? { status: query.status } : {}),
      ...(query.priority ? { priority: query.priority } : {}),
      ...(search ? { subject: { contains: search } } : {}),
    };
    const [items, total, stats] = await Promise.all([
      prisma.ticket.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      prisma.ticket.count({ where }),
      ticketStats(guild.id),
    ]);
    return reply.send({ items, total, page, pageSize, stats });
  });

  app.get('/guilds/:guildId/tickets/:ticketId/transcript', { preHandler: requireGuild('tickets') }, async (request, reply) => {
    const guild = request.guild!;
    const { ticketId } = request.params as { ticketId: string };
    const transcript = await prisma.ticketTranscript.findFirst({ where: { id: ticketId, guildId: guild.id } });
    if (!transcript) return notFound(reply, 'Transcript not found');
    return reply.header('content-type', 'text/html; charset=utf-8').send(transcript.html);
  });

  app.get('/guilds/:guildId/tickets/panels', { preHandler: requireGuild('tickets') }, async (request, reply) => {
    const guild = request.guild!;
    return reply.send({ items: await prisma.ticketPanel.findMany({ where: { guildId: guild.id }, orderBy: { createdAt: 'desc' } }) });
  });

  const panelSchema = z.object({
    name: z.string().min(1).max(80),
    description: z.string().max(1500).optional(),
    channelId: snowflake.optional(),
    categoryId: snowflake.nullish(),
    supportRoleIds: z.array(snowflake).max(10).default([]),
    pingRoleIds: z.array(snowflake).max(10).default([]),
    buttonLabel: z.string().min(1).max(80).default('Open a ticket'),
    buttonEmoji: z.string().max(100).nullish(),
    formFields: z
      .array(
        z.object({
          key: z.string().min(1).max(40),
          label: z.string().min(1).max(80),
          style: z.enum(['short', 'paragraph']).default('short'),
          required: z.boolean().default(true),
          maxLength: z.number().int().min(1).max(1024).default(200),
        }),
      )
      .max(5)
      .default([]),
    openMessage: z.string().max(1500).nullish(),
    defaultPriority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
    enabled: z.boolean().default(true),
  });

  app.post('/guilds/:guildId/tickets/panels', { preHandler: requireGuild('tickets') }, async (request, reply) => {
    const guild = request.guild!;
    const parsed = panelSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Invalid ticket panel.', details: parsed.error.flatten() });
    const panel = await prisma.ticketPanel.create({
      data: {
        guildId: guild.id,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        channelId: parsed.data.channelId ?? null,
        categoryId: parsed.data.categoryId ?? null,
        supportRoleIds: parsed.data.supportRoleIds as never,
        pingRoleIds: parsed.data.pingRoleIds as never,
        buttonLabel: parsed.data.buttonLabel,
        buttonEmoji: parsed.data.buttonEmoji ?? null,
        formFields: parsed.data.formFields as never,
        openMessage: parsed.data.openMessage ?? null,
        defaultPriority: parsed.data.defaultPriority,
        enabled: parsed.data.enabled,
      },
    });
    await audit(request, 'tickets.panel_create', { type: 'ticket_panel', id: panel.id, after: panel });
    return reply.code(201).send(panel);
  });

  app.patch('/guilds/:guildId/tickets/panels/:panelId', { preHandler: requireGuild('tickets') }, async (request, reply) => {
    const guild = request.guild!;
    const { panelId } = request.params as { panelId: string };
    const existing = await prisma.ticketPanel.findFirst({ where: { id: panelId, guildId: guild.id } });
    if (!existing) return notFound(reply, 'Panel not found');
    const parsed = panelSchema.partial().safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Invalid ticket panel.', details: parsed.error.flatten() });
    const panel = await prisma.ticketPanel.update({
      where: { id: panelId },
      data: {
        ...parsed.data,
        supportRoleIds: parsed.data.supportRoleIds as never,
        pingRoleIds: parsed.data.pingRoleIds as never,
        formFields: parsed.data.formFields as never,
        categoryId: parsed.data.categoryId ?? existing.categoryId,
      },
    });
    await audit(request, 'tickets.panel_update', { type: 'ticket_panel', id: panelId, before: existing, after: panel });
    return reply.send(panel);
  });

  app.delete('/guilds/:guildId/tickets/panels/:panelId', { preHandler: requireGuild('tickets') }, async (request, reply) => {
    const guild = request.guild!;
    const { panelId } = request.params as { panelId: string };
    const existing = await prisma.ticketPanel.findFirst({ where: { id: panelId, guildId: guild.id } });
    if (!existing) return notFound(reply, 'Panel not found');
    await prisma.ticketPanel.delete({ where: { id: panelId } });
    await audit(request, 'tickets.panel_delete', { type: 'ticket_panel', id: panelId });
    return reply.send({ ok: true });
  });

  app.post('/guilds/:guildId/tickets/panels/:panelId/post', { preHandler: requireGuild('tickets') }, async (request, reply) => {
    const guild = request.guild!;
    if (requireBot(reply, guild.botPresent)) return;
    const { panelId } = request.params as { panelId: string };
    const panel = await prisma.ticketPanel.findFirst({ where: { id: panelId, guildId: guild.id } });
    if (!panel) return notFound(reply, 'Panel not found');
    const body = z.object({ channelId: snowflake.optional() }).safeParse(request.body ?? {});
    const channelId = (body.success ? body.data.channelId : undefined) ?? panel.channelId;
    if (!channelId) return reply.code(400).send({ error: 'invalid_request', message: 'Choose a channel for this panel.' });

    const message = await discordApi.createMessage(channelId, {
      embeds: [
        {
          title: panel.name,
          description: panel.description ?? 'Open a ticket and our team will help you shortly.',
          color: 0x5865f2,
          footer: { text: 'IRH CORE • Tickets' },
        },
      ],
      components: [
        {
          type: 1,
          components: [{ type: 2, style: 1, label: panel.buttonLabel, custom_id: `ticket:open:${panel.id}` }],
        },
      ],
    });
    await prisma.ticketPanel.update({ where: { id: panel.id }, data: { channelId, messageId: message.id } });
    await audit(request, 'tickets.panel_post', { type: 'ticket_panel', id: panel.id });
    broadcast({ type: 'tickets.panel_posted', guildId: guild.discordId, payload: { panelId: panel.id } });
    return reply.send({ ok: true, messageId: message.id });
  });

  app.post('/guilds/:guildId/tickets/:ticketId/close', { preHandler: requireGuild('tickets') }, async (request, reply) => {
    const guild = request.guild!;
    const { ticketId } = request.params as { ticketId: string };
    const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, guildId: guild.id } });
    if (!ticket) return notFound(reply, 'Ticket not found');
    if (ticket.status === 'closed') return reply.code(409).send({ error: 'already_closed', message: 'This ticket is already closed.' });
    await enqueueJob({
      type: 'ticket.close',
      guildId: guild.id,
      payload: { ticketId: ticket.id, closedById: request.auth!.user.discordId, reason: 'Closed from dashboard' },
      dedupeKey: `ticket.close:${ticket.id}`,
    });
    await audit(request, 'tickets.close_requested', { type: 'ticket', id: ticket.id });
    return reply.send({ ok: true, queued: true });
  });

  // ── reaction roles ──────────────────────────────────────────
  app.get('/guilds/:guildId/reaction-roles', { preHandler: requireGuild('reactionroles') }, async (request, reply) => {
    const guild = request.guild!;
    return reply.send({ items: await prisma.reactionRolePanel.findMany({ where: { guildId: guild.id }, orderBy: { createdAt: 'desc' } }) });
  });

  const reactionPanelSchema = z.object({
    name: z.string().min(1).max(80),
    description: z.string().max(1500).optional(),
    channelId: snowflake,
    mode: z.enum(['button', 'select', 'reaction']).default('button'),
    unique: z.boolean().default(false),
    options: z
      .array(
        z.object({
          roleId: snowflake,
          label: z.string().max(80).optional(),
          emoji: z.string().max(100).optional(),
          description: z.string().max(100).optional(),
        }),
      )
      .min(1)
      .max(25),
  });

  app.post('/guilds/:guildId/reaction-roles', { preHandler: requireGuild('reactionroles') }, async (request, reply) => {
    const guild = request.guild!;
    const parsed = reactionPanelSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Invalid reaction role panel.', details: parsed.error.flatten() });
    const panel = await prisma.reactionRolePanel.create({
      data: {
        guildId: guild.id,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        channelId: parsed.data.channelId,
        mode: parsed.data.mode,
        unique: parsed.data.unique,
        options: parsed.data.options as never,
      },
    });
    await audit(request, 'reactionroles.create', { type: 'reaction_role_panel', id: panel.id });
    return reply.code(201).send(panel);
  });

  app.patch('/guilds/:guildId/reaction-roles/:panelId', { preHandler: requireGuild('reactionroles') }, async (request, reply) => {
    const guild = request.guild!;
    const { panelId } = request.params as { panelId: string };
    const existing = await prisma.reactionRolePanel.findFirst({ where: { id: panelId, guildId: guild.id } });
    if (!existing) return notFound(reply, 'Panel not found');
    const parsed = reactionPanelSchema.partial().safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Invalid panel update.', details: parsed.error.flatten() });
    const panel = await prisma.reactionRolePanel.update({
      where: { id: panelId },
      data: { ...parsed.data, options: parsed.data.options as never },
    });
    await audit(request, 'reactionroles.update', { type: 'reaction_role_panel', id: panelId });
    return reply.send(panel);
  });

  app.delete('/guilds/:guildId/reaction-roles/:panelId', { preHandler: requireGuild('reactionroles') }, async (request, reply) => {
    const guild = request.guild!;
    const { panelId } = request.params as { panelId: string };
    const existing = await prisma.reactionRolePanel.findFirst({ where: { id: panelId, guildId: guild.id } });
    if (!existing) return notFound(reply, 'Panel not found');
    await prisma.reactionRolePanel.delete({ where: { id: panelId } });
    await audit(request, 'reactionroles.delete', { type: 'reaction_role_panel', id: panelId });
    return reply.send({ ok: true });
  });

  app.post('/guilds/:guildId/reaction-roles/:panelId/post', { preHandler: requireGuild('reactionroles') }, async (request, reply) => {
    const guild = request.guild!;
    if (requireBot(reply, guild.botPresent)) return;
    const { panelId } = request.params as { panelId: string };
    const panel = await prisma.reactionRolePanel.findFirst({ where: { id: panelId, guildId: guild.id } });
    if (!panel) return notFound(reply, 'Panel not found');
    const options = (panel.options as unknown as { roleId: string; label?: string; emoji?: string; description?: string }[]) ?? [];
    const payload: Record<string, unknown> = {
      embeds: [{ title: panel.name, description: panel.description ?? 'Select a role below.', color: 0x5865f2 }],
    };
    if (panel.mode === 'button') {
      payload.components = [
        {
          type: 1,
          components: options.slice(0, 5).map((option, index) => ({
            type: 2,
            style: 2,
            label: option.label ?? `Role ${index + 1}`,
            custom_id: `rr:toggle:${panel.id}:${option.roleId}`,
            ...(option.emoji ? { emoji: option.emoji.includes(':') ? undefined : { name: option.emoji } } : {}),
          })),
        },
      ];
    } else if (panel.mode === 'select') {
      payload.components = [
        {
          type: 1,
          components: [
            {
              type: 3,
              custom_id: `rr:select:${panel.id}`,
              placeholder: 'Choose your roles',
              min_values: 0,
              max_values: panel.unique ? 1 : Math.min(options.length, 25),
              options: options.slice(0, 25).map((option) => ({
                label: option.label ?? option.roleId,
                value: option.roleId,
                description: option.description,
              })),
            },
          ],
        },
      ];
    }

    const message = await discordApi.createMessage(panel.channelId, payload);
    await prisma.reactionRolePanel.update({ where: { id: panel.id }, data: { messageId: message.id } });
    if (panel.mode === 'reaction') {
      for (const option of options) {
        if (!option.emoji) continue;
        await fetch(`https://discord.com/api/v10/channels/${panel.channelId}/messages/${message.id}/reactions/${encodeURIComponent(option.emoji)}/@me`, {
          method: 'PUT',
          headers: { authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
        }).catch(() => undefined);
      }
    }
    await audit(request, 'reactionroles.post', { type: 'reaction_role_panel', id: panel.id });
    return reply.send({ ok: true, messageId: message.id });
  });

  // ── verification / welcome test posts ───────────────────────
  app.post('/guilds/:guildId/verification/post', { preHandler: requireGuild('verification') }, async (request, reply) => {
    const guild = request.guild!;
    if (requireBot(reply, guild.botPresent)) return;
    const settings = await getModuleSettings<{ channelId: string | null; message: string; rulesText: string }>(guild.id, 'verification');
    const channelId = (request.body as { channelId?: string } | undefined)?.channelId ?? settings.channelId;
    if (!channelId) return reply.code(400).send({ error: 'invalid_request', message: 'Choose a verification channel first.' });
    const message = await discordApi.createMessage(channelId, {
      embeds: [
        {
          title: 'Verification',
          description: `${settings.message}${settings.rulesText ? `\n\n${settings.rulesText}` : ''}`,
          color: 0x5865f2,
        },
      ],
      components: [{ type: 1, components: [{ type: 2, style: 3, label: 'Verify', custom_id: `verify:start:${guild.discordId}` }] }],
    });
    await audit(request, 'verification.post', { type: 'channel', id: channelId });
    return reply.send({ ok: true, messageId: message.id });
  });

  app.post('/guilds/:guildId/welcome/test', { preHandler: requireGuild('welcome') }, async (request, reply) => {
    const guild = request.guild!;
    if (requireBot(reply, guild.botPresent)) return;
    const settings = await getModuleSettings<{ channelId: string | null; message: string; useEmbed: boolean; embedColor: number }>(guild.id, 'welcome');
    const channelId = settings.channelId;
    if (!channelId) return reply.code(400).send({ error: 'invalid_request', message: 'Choose a welcome channel first.' });
    const message = await discordApi.createMessage(channelId, {
      content: settings.useEmbed ? undefined : `**Preview:** ${settings.message}`,
      embeds: settings.useEmbed ? [{ title: 'Welcome preview', description: settings.message, color: settings.embedColor }] : undefined,
    });
    return reply.send({ ok: true, messageId: message.id });
  });

  // ── giveaways ───────────────────────────────────────────────
  app.get('/guilds/:guildId/giveaways', { preHandler: requireGuild('giveaways') }, async (request, reply) => {
    const guild = request.guild!;
    const { page, pageSize } = pagination(request);
    const query = z.object({ status: z.string().optional() }).parse(request.query ?? {});
    const where = { guildId: guild.id, ...(query.status ? { status: query.status } : {}) };
    const [items, total] = await Promise.all([
      prisma.giveaway.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { _count: { select: { entries: true } } },
      }),
      prisma.giveaway.count({ where }),
    ]);
    return reply.send({ items, total, page, pageSize });
  });

  app.post('/guilds/:guildId/giveaways', { preHandler: requireGuild('giveaways') }, async (request, reply) => {
    const guild = request.guild!;
    const parsed = z
      .object({
        prize: z.string().min(1).max(200),
        description: z.string().max(1000).optional(),
        channelId: snowflake,
        winnerCount: z.number().int().min(1).max(50).default(1),
        durationMs: z.number().int().min(10_000).max(90 * 86_400_000),
        requiredRoleIds: z.array(snowflake).max(10).default([]),
        bonusRoleIds: z.array(snowflake).max(10).default([]),
        minAccountAgeDays: z.number().int().min(0).max(365).default(0),
        minServerAgeDays: z.number().int().min(0).max(365).default(0),
        startAt: z.string().datetime().optional(),
      })
      .safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Invalid giveaway.', details: parsed.error.flatten() });
    const startAt = parsed.data.startAt ? new Date(parsed.data.startAt) : new Date();
    const endsAt = new Date(startAt.getTime() + parsed.data.durationMs);
    const giveaway = await prisma.giveaway.create({
      data: {
        guildId: guild.id,
        channelId: parsed.data.channelId,
        winners: [] as never,
        prize: parsed.data.prize,
        description: parsed.data.description ?? null,
        winnerCount: parsed.data.winnerCount,
        hostId: request.auth!.user.discordId,
        requiredRoleIds: parsed.data.requiredRoleIds as never,
        bonusRoles: parsed.data.bonusRoleIds as never,
        minAccountAgeDays: parsed.data.minAccountAgeDays,
        minServerAgeDays: parsed.data.minServerAgeDays,
        endsAt,
        status: startAt.getTime() > Date.now() + 30_000 ? 'scheduled' : 'running',
      },
    });
    if (giveaway.status === 'running') {
      await enqueueJob({ type: 'giveaway.start', guildId: guild.id, payload: { giveawayId: giveaway.id }, dedupeKey: `giveaway.start:${giveaway.id}`, priority: 5 });
    } else {
      await enqueueJob({ type: 'giveaway.start', guildId: guild.id, payload: { giveawayId: giveaway.id }, runAt: startAt, dedupeKey: `giveaway.start:${giveaway.id}` });
    }
    await enqueueJob({ type: 'giveaway.end', guildId: guild.id, payload: { giveawayId: giveaway.id }, runAt: endsAt, dedupeKey: `giveaway.end:${giveaway.id}` });
    await audit(request, 'giveaway.create', { type: 'giveaway', id: giveaway.id, after: giveaway });
    broadcast({ type: 'giveaway.created', guildId: guild.discordId, payload: { id: giveaway.id } });
    return reply.code(201).send(giveaway);
  });

  app.post('/guilds/:guildId/giveaways/:giveawayId/end', { preHandler: requireGuild('giveaways') }, async (request, reply) => {
    const guild = request.guild!;
    const { giveawayId } = request.params as { giveawayId: string };
    const giveaway = await prisma.giveaway.findFirst({ where: { id: giveawayId, guildId: guild.id } });
    if (!giveaway) return notFound(reply, 'Giveaway not found');
    if (giveaway.status === 'ended') return reply.code(409).send({ error: 'already_ended', message: 'That giveaway already ended.' });
    await enqueueJob({ type: 'giveaway.end', guildId: guild.id, payload: { giveawayId, force: true }, dedupeKey: `giveaway.end:${giveawayId}:force`, priority: 9 });
    return reply.send({ ok: true, queued: true });
  });

  app.post('/guilds/:guildId/giveaways/:giveawayId/reroll', { preHandler: requireGuild('giveaways') }, async (request, reply) => {
    const guild = request.guild!;
    const { giveawayId } = request.params as { giveawayId: string };
    const giveaway = await prisma.giveaway.findFirst({ where: { id: giveawayId, guildId: guild.id } });
    if (!giveaway) return notFound(reply, 'Giveaway not found');
    if (giveaway.status !== 'ended') return reply.code(409).send({ error: 'not_ended', message: 'Only ended giveaways can be rerolled.' });
    await enqueueJob({
      type: 'giveaway.reroll',
      guildId: guild.id,
      payload: { giveawayId, count: (request.body as { count?: number } | undefined)?.count ?? 1 },
      dedupeKey: `giveaway.reroll:${giveawayId}:${Date.now()}`,
    });
    return reply.send({ ok: true, queued: true });
  });

  app.post('/guilds/:guildId/giveaways/:giveawayId/pause', { preHandler: requireGuild('giveaways') }, async (request, reply) => {
    const guild = request.guild!;
    const { giveawayId } = request.params as { giveawayId: string };
    const giveaway = await prisma.giveaway.findFirst({ where: { id: giveawayId, guildId: guild.id } });
    if (!giveaway) return notFound(reply, 'Giveaway not found');
    if (giveaway.status === 'paused') {
      const pausedFor = giveaway.pausedAt ? Date.now() - giveaway.pausedAt.getTime() : 0;
      const updated = await prisma.giveaway.update({
        where: { id: giveaway.id },
        data: { status: 'running', pausedAt: null, totalPausedMs: giveaway.totalPausedMs + pausedFor, endsAt: new Date(giveaway.endsAt.getTime() + pausedFor) },
      });
      await enqueueJob({ type: 'giveaway.end', guildId: guild.id, payload: { giveawayId }, runAt: updated.endsAt, dedupeKey: `giveaway.end:${giveawayId}` });
      return reply.send(updated);
    }
    const updated = await prisma.giveaway.update({ where: { id: giveaway.id }, data: { status: 'paused', pausedAt: new Date() } });
    return reply.send(updated);
  });

  app.delete('/guilds/:guildId/giveaways/:giveawayId', { preHandler: requireGuild('giveaways') }, async (request, reply) => {
    const guild = request.guild!;
    const { giveawayId } = request.params as { giveawayId: string };
    const giveaway = await prisma.giveaway.findFirst({ where: { id: giveawayId, guildId: guild.id } });
    if (!giveaway) return notFound(reply, 'Giveaway not found');
    await prisma.giveaway.delete({ where: { id: giveaway.id } });
    await audit(request, 'giveaway.delete', { type: 'giveaway', id: giveawayId });
    return reply.send({ ok: true });
  });

  // ── invites ─────────────────────────────────────────────────
  app.get('/guilds/:guildId/invites', { preHandler: requireGuild('invites') }, async (request, reply) => {
    const guild = request.guild!;
    const [events, aggregated] = await Promise.all([
      prisma.inviteEvent.findMany({ where: { guildId: guild.id }, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.inviteEvent.groupBy({
        by: ['inviterId'],
        where: { guildId: guild.id, type: 'join', fake: false },
        _count: { _all: true },
        orderBy: { _count: { inviterId: 'desc' } },
        take: 25,
      }),
    ]);
    const leaves = await prisma.inviteEvent.groupBy({ by: ['inviterId'], where: { guildId: guild.id, type: 'leave' }, _count: { _all: true } });
    return reply.send({
      events,
      leaderboard: aggregated.map((row) => ({
        inviterId: row.inviterId,
        joins: row._count._all,
        leaves: leaves.find((leave) => leave.inviterId === row.inviterId)?._count._all ?? 0,
      })),
      activeInvites: await prisma.invite.count({ where: { guildId: guild.id } }),
    });
  });

  app.post('/guilds/:guildId/invites/track', { preHandler: requireGuild('invites') }, async (request, reply) => {
    const guild = request.guild!;
    if (requireBot(reply, guild.botPresent)) return;
    const parsed = z.object({ channelId: snowflake, maxAge: z.number().int().min(0).max(604_800).default(0) }).safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Invalid invite request.' });
    const invite = await discordApi.createInvite(parsed.data.channelId, { max_age: parsed.data.maxAge, unique: true });
    const record = await prisma.invite.upsert({
      where: { guildId_code: { guildId: guild.id, code: invite.code } },
      create: { guildId: guild.id, code: invite.code, inviterId: request.auth!.user.discordId, channelId: parsed.data.channelId },
      update: { channelId: parsed.data.channelId },
    });
    return reply.send({ ...record, url: `https://discord.gg/${invite.code}`, placeholder: randomCode(4) });
  });

  // ── leveling ────────────────────────────────────────────────
  app.get('/guilds/:guildId/leveling/leaderboard', { preHandler: requireGuild('leveling') }, async (request, reply) => {
    const guild = request.guild!;
    const [xp, voice] = await Promise.all([xpLeaderboard(guild.id, 25), voiceLeaderboard(guild.id, 25)]);
    return reply.send({ xp, voice });
  });

  app.get('/guilds/:guildId/leveling/rewards', { preHandler: requireGuild('leveling') }, async (request, reply) => {
    const guild = request.guild!;
    return reply.send({ items: await prisma.levelReward.findMany({ where: { guildId: guild.id }, orderBy: { level: 'asc' } }) });
  });

  app.post('/guilds/:guildId/leveling/rewards', { preHandler: requireGuild('leveling') }, async (request, reply) => {
    const guild = request.guild!;
    const parsed = z
      .object({ level: z.number().int().min(1).max(500), roleId: snowflake, removeOnLower: z.boolean().default(false) })
      .safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Invalid reward.' });
    const reward = await prisma.levelReward.upsert({
      where: { guildId_level_roleId: { guildId: guild.id, level: parsed.data.level, roleId: parsed.data.roleId } },
      create: { guildId: guild.id, level: parsed.data.level, roleId: parsed.data.roleId, removeOnLower: parsed.data.removeOnLower },
      update: { removeOnLower: parsed.data.removeOnLower },
    });
    await audit(request, 'leveling.reward_create', { type: 'level_reward', id: reward.id });
    return reply.code(201).send(reward);
  });

  app.delete('/guilds/:guildId/leveling/rewards/:rewardId', { preHandler: requireGuild('leveling') }, async (request, reply) => {
    const guild = request.guild!;
    const { rewardId } = request.params as { rewardId: string };
    await prisma.levelReward.deleteMany({ where: { id: rewardId, guildId: guild.id } });
    await audit(request, 'leveling.reward_delete', { type: 'level_reward', id: rewardId });
    return reply.send({ ok: true });
  });

  app.get('/guilds/:guildId/voice-master', { preHandler: requireGuild('voicemaster') }, async (request, reply) => {
    const guild = request.guild!;
    const channels = await prisma.voiceMasterChannel.findMany({ where: { guildId: guild.id }, orderBy: { createdAt: 'desc' } });
    return reply.send({ items: channels, active: channels.length });
  });

  app.get('/guilds/:guildId/scheduled-jobs', { preHandler: requireGuild() }, async (request, reply) => {
    const guild = request.guild!;
    const items = await prisma.scheduledJob.findMany({ where: { guildId: guild.id }, orderBy: { runAt: 'asc' }, take: 100 });
    return reply.send({ items });
  });

  void recordAudit;
}
