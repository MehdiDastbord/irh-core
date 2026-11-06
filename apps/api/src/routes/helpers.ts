/** Small helpers shared by route modules. */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { paginationSchema } from '@irh/shared';
import { recordAudit } from '@irh/db';

export function pagination(request: FastifyRequest) {
  const parsed = paginationSchema.safeParse(request.query ?? {});
  if (!parsed.success) return { page: 1, pageSize: 25, search: undefined as string | undefined };
  return parsed.data;
}

export function notFound(reply: FastifyReply, message = 'Resource not found') {
  return reply.code(404).send({ error: 'not_found', message });
}

export function badRequest(reply: FastifyReply, message: string, details?: unknown) {
  return reply.code(400).send({ error: 'bad_request', message, details });
}

export function requireBot(reply: FastifyReply, botPresent: boolean) {
  if (botPresent) return false;
  reply.code(409).send({
    error: 'bot_missing',
    message: 'IRH CORE is not in this server yet. Invite the bot before using Discord actions.',
  });
  return true;
}

export async function audit(request: FastifyRequest, action: string, target?: { type?: string; id?: string; before?: unknown; after?: unknown }) {
  await recordAudit({
    guildId: request.guild?.id ?? null,
    actorId: request.auth?.user.discordId ?? null,
    actorType: 'user',
    action,
    targetType: target?.type,
    targetId: target?.id,
    before: target?.before,
    after: target?.after,
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
  });
}
