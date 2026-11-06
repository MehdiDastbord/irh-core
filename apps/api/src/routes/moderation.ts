/** Moderation dashboard endpoints. */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { moderationStats, listCases, prisma, recordAudit, revokeWarning } from '@irh/db';
import { requireGuild } from '../auth.js';
import { performModeration, ModerationError } from '../moderation-actions.js';
import { audit, notFound, pagination, requireBot } from './helpers.js';

const actionSchema = z.object({
  action: z.enum(['ban', 'unban', 'kick', 'timeout', 'warn', 'softban']),
  targetId: z.string().regex(/^\d{15,25}$/),
  reason: z.string().max(500).optional(),
  durationMs: z.number().int().min(0).max(1000 * 60 * 60 * 24 * 365).optional(),
  deleteMessageSeconds: z.number().int().min(0).max(604_800).optional(),
});

export async function moderationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/guilds/:guildId/moderation/stats', { preHandler: requireGuild('moderation') }, async (request, reply) => {
    return reply.send(await moderationStats(request.guild!.id));
  });

  app.get('/guilds/:guildId/moderation/cases', { preHandler: requireGuild('moderation') }, async (request, reply) => {
    const guild = request.guild!;
    const { page, pageSize, search } = pagination(request);
    const query = z
      .object({ action: z.string().optional(), targetId: z.string().optional(), moderatorId: z.string().optional(), active: z.coerce.boolean().optional() })
      .parse(request.query ?? {});
    if (search && /^\d{15,25}$/.test(search)) {
      const byTarget = await listCases(guild.id, { page, pageSize, targetId: search });
      return reply.send(byTarget);
    }
    return reply.send(await listCases(guild.id, { page, pageSize, action: query.action, targetId: query.targetId, moderatorId: query.moderatorId, activeOnly: query.active }));
  });

  app.get('/guilds/:guildId/moderation/cases/:caseId', { preHandler: requireGuild('moderation') }, async (request, reply) => {
    const guild = request.guild!;
    const { caseId } = request.params as { caseId: string };
    const record = await prisma.moderationCase.findFirst({
      where: { guildId: guild.id, OR: [{ id: caseId }, { caseNumber: Number(caseId) || -1 }] },
      include: { warnings: true, appeals: true },
    });
    if (!record) return notFound(reply, 'Case not found');
    return reply.send(record);
  });

  app.post('/guilds/:guildId/moderation/actions', { preHandler: requireGuild('moderation') }, async (request, reply) => {
    const guild = request.guild!;
    if (requireBot(reply, guild.botPresent)) return;
    const parsed = actionSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', message: 'Invalid moderation action.', details: parsed.error.flatten() });
    try {
      const result = await performModeration({
        guildId: guild.discordId,
        internalGuildId: guild.id,
        actorId: request.auth!.user.discordId,
        ...parsed.data,
      });
      await audit(request, `moderation.${parsed.data.action}`, { type: 'member', id: parsed.data.targetId });
      return reply.send(result);
    } catch (error) {
      if (error instanceof ModerationError) return reply.code(error.status).send({ error: 'action_failed', message: error.message });
      request.log.error(error);
      return reply.code(500).send({ error: 'action_failed', message: 'The action failed unexpectedly.' });
    }
  });

  app.patch('/guilds/:guildId/moderation/cases/:caseId', { preHandler: requireGuild('moderation') }, async (request, reply) => {
    const guild = request.guild!;
    const { caseId } = request.params as { caseId: string };
    const body = z.object({ notes: z.string().max(2000).optional(), reason: z.string().max(500).optional(), active: z.boolean().optional() }).safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: 'Invalid case update.' });
    const existing = await prisma.moderationCase.findFirst({ where: { guildId: guild.id, id: caseId } });
    if (!existing) return notFound(reply, 'Case not found');
    const updated = await prisma.moderationCase.update({ where: { id: existing.id }, data: body.data });
    await recordAudit({ guildId: guild.id, actorId: request.auth!.user.discordId, action: 'moderation.case_update', targetType: 'case', targetId: caseId, before: existing, after: updated });
    return reply.send(updated);
  });

  app.get('/guilds/:guildId/moderation/warnings', { preHandler: requireGuild('moderation') }, async (request, reply) => {
    const guild = request.guild!;
    const { page, pageSize } = pagination(request);
    const query = z.object({ userId: z.string().regex(/^\d{15,25}$/).optional(), active: z.enum(['true', 'false']).optional() }).parse(request.query ?? {});
    const where = {
      guildId: guild.id,
      ...(query.userId ? { targetId: query.userId } : {}),
      ...(query.active ? { active: query.active === 'true' } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.warning.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      prisma.warning.count({ where }),
    ]);
    return reply.send({ items, total, page, pageSize });
  });

  app.delete('/guilds/:guildId/moderation/warnings/:warningId', { preHandler: requireGuild('moderation') }, async (request, reply) => {
    const guild = request.guild!;
    const { warningId } = request.params as { warningId: string };
    const warning = await prisma.warning.findFirst({ where: { id: warningId, guildId: guild.id } });
    if (!warning) return notFound(reply, 'Warning not found');
    await revokeWarning(guild.id, warningId, request.auth!.user.discordId);
    await audit(request, 'moderation.warn_revoked', { type: 'warning', id: warningId });
    return reply.send({ ok: true });
  });

  app.get('/guilds/:guildId/moderation/notes', { preHandler: requireGuild('moderation') }, async (request, reply) => {
    const guild = request.guild!;
    const { page, pageSize } = pagination(request);
    const query = z.object({ userId: z.string().regex(/^\d{15,25}$/).optional() }).parse(request.query ?? {});
    const where = { guildId: guild.id, ...(query.userId ? { targetId: query.userId } : {}) };
    const [items, total] = await Promise.all([
      prisma.moderatorNote.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      prisma.moderatorNote.count({ where }),
    ]);
    return reply.send({ items, total, page, pageSize });
  });

  app.post('/guilds/:guildId/moderation/notes', { preHandler: requireGuild('moderation') }, async (request, reply) => {
    const guild = request.guild!;
    const body = z.object({ targetId: z.string().regex(/^\d{15,25}$/), note: z.string().min(1).max(2000) }).safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: 'A target and note are required.' });
    const note = await prisma.moderatorNote.create({
      data: { guildId: guild.id, targetId: body.data.targetId, authorId: request.auth!.user.discordId, note: body.data.note },
    });
    await audit(request, 'moderation.note_created', { type: 'member', id: body.data.targetId });
    return reply.send(note);
  });

  app.get('/guilds/:guildId/moderation/appeals', { preHandler: requireGuild('moderation') }, async (request, reply) => {
    const guild = request.guild!;
    const { page, pageSize } = pagination(request);
    const query = z.object({ status: z.string().optional() }).parse(request.query ?? {});
    const where = { guildId: guild.id, ...(query.status ? { status: query.status } : {}) };
    const [items, total] = await Promise.all([
      prisma.appeal.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      prisma.appeal.count({ where }),
    ]);
    return reply.send({ items, total, page, pageSize });
  });

  app.patch('/guilds/:guildId/moderation/appeals/:appealId', { preHandler: requireGuild('moderation') }, async (request, reply) => {
    const guild = request.guild!;
    const { appealId } = request.params as { appealId: string };
    const body = z.object({ status: z.enum(['pending', 'accepted', 'rejected']), reviewNote: z.string().max(2000).optional() }).safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: 'Invalid appeal decision.' });
    const appeal = await prisma.appeal.findFirst({ where: { id: appealId, guildId: guild.id } });
    if (!appeal) return notFound(reply, 'Appeal not found');
    const updated = await prisma.appeal.update({
      where: { id: appeal.id },
      data: { status: body.data.status, reviewNote: body.data.reviewNote ?? null, reviewedById: request.auth!.user.discordId, reviewedAt: new Date() },
    });
    await audit(request, 'moderation.appeal_reviewed', { type: 'appeal', id: appealId, after: updated });
    return reply.send(updated);
  });

  const securityList = async (request: FastifyRequest, reply: FastifyReply) => {
    const guild = request.guild!;
    const { page, pageSize } = pagination(request);
    const query = z.object({ status: z.string().optional(), type: z.string().optional() }).parse(request.query ?? {});
    const where = { guildId: guild.id, ...(query.status ? { status: query.status } : {}), ...(query.type ? { type: query.type } : {}) };
    const [items, total] = await Promise.all([
      prisma.securityIncident.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      prisma.securityIncident.count({ where }),
    ]);
    return reply.send({ items, total, page, pageSize });
  };
  app.get('/guilds/:guildId/security/incidents', { preHandler: requireGuild('security') }, securityList);

  app.patch('/guilds/:guildId/security/incidents/:incidentId', { preHandler: requireGuild('security') }, async (request, reply) => {
    const guild = request.guild!;
    const { incidentId } = request.params as { incidentId: string };
    const body = z.object({ status: z.enum(['open', 'resolved', 'ignored']).optional(), actionTaken: z.string().max(500).optional() }).safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: 'Invalid incident update.' });
    const incident = await prisma.securityIncident.findFirst({ where: { id: incidentId, guildId: guild.id } });
    if (!incident) return notFound(reply, 'Incident not found');
    const updated = await prisma.securityIncident.update({
      where: { id: incident.id },
      data: {
        ...(body.data.status ? { status: body.data.status, resolvedAt: body.data.status === 'resolved' ? new Date() : null, resolvedById: request.auth!.user.discordId } : {}),
        ...(body.data.actionTaken ? { actionTaken: body.data.actionTaken } : {}),
      },
    });
    await audit(request, 'security.incident_update', { type: 'incident', id: incidentId, after: updated });
    return reply.send(updated);
  });

  app.get('/guilds/:guildId/security/trusted', { preHandler: requireGuild('security') }, async (request, reply) => {
    const guild = request.guild!;
    return reply.send({ items: await prisma.trustedUser.findMany({ where: { guildId: guild.id }, orderBy: { createdAt: 'desc' } }) });
  });

  app.post('/guilds/:guildId/security/trusted', { preHandler: requireGuild('security') }, async (request, reply) => {
    const guild = request.guild!;
    const body = z.object({ userId: z.string().regex(/^\d{15,25}$/), reason: z.string().max(300).optional() }).safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: 'A valid user id is required.' });
    const record = await prisma.trustedUser.upsert({
      where: { guildId_userId: { guildId: guild.id, userId: body.data.userId } },
      create: { guildId: guild.id, userId: body.data.userId, reason: body.data.reason ?? null },
      update: { reason: body.data.reason ?? null },
    });
    await audit(request, 'security.trust_add', { type: 'user', id: body.data.userId });
    return reply.send(record);
  });

  app.delete('/guilds/:guildId/security/trusted/:userId', { preHandler: requireGuild('security') }, async (request, reply) => {
    const guild = request.guild!;
    const { userId } = request.params as { userId: string };
    await prisma.trustedUser.deleteMany({ where: { guildId: guild.id, userId } });
    await audit(request, 'security.trust_remove', { type: 'user', id: userId });
    return reply.send({ ok: true });
  });
}
