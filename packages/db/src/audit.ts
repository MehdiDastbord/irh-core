/** Audit trail helper — every mutating action is recorded. */

import type { Prisma } from '@prisma/client';
import { prisma } from './index.js';
import { logger } from './logger.js';

export interface AuditInput {
  guildId?: string | null;
  actorId?: string | null;
  actorType?: 'user' | 'system' | 'bot';
  action: string;
  targetType?: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditRecord.create({
      data: {
        guildId: input.guildId ?? null,
        actorId: input.actorId ?? null,
        actorType: input.actorType ?? 'user',
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        before: (input.before ?? undefined) as Prisma.InputJsonValue | undefined,
        after: (input.after ?? undefined) as Prisma.InputJsonValue | undefined,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
  } catch (error) {
    // Audit failures must never break the calling action.
    logger.error('audit', 'Failed to record audit entry', { action: input.action, error });
  }
}

export async function listAudit(guildId: string, options: { page?: number; pageSize?: number; action?: string } = {}) {
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 25));
  const where = { guildId, ...(options.action ? { action: { contains: options.action } } : {}) };
  const [items, total] = await Promise.all([
    prisma.auditRecord.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.auditRecord.count({ where }),
  ]);
  return { items, total, page, pageSize };
}
