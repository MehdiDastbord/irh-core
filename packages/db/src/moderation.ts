/** Moderation cases, warnings and escalation logic. */

import type { PrismaClient } from '@prisma/client';
import { prisma } from './client.js';

export interface EscalationStep {
  warnings: number;
  action: string;
  durationMs?: number;
}

export interface EscalationDecision {
  action: string;
  durationMs?: number;
  threshold: number;
}

/**
 * Pick the highest escalation step whose threshold is met.
 * Pure function so the policy can be unit tested.
 */
export function decideEscalation(activeWarnings: number, steps: EscalationStep[]): EscalationDecision | null {
  if (!Array.isArray(steps) || steps.length === 0) return null;
  const sorted = [...steps]
    .filter((step) => step && Number.isFinite(step.warnings) && typeof step.action === 'string')
    .sort((a, b) => a.warnings - b.warnings);
  let chosen: EscalationDecision | null = null;
  for (const step of sorted) {
    if (activeWarnings >= step.warnings) {
      chosen = { action: step.action, durationMs: step.durationMs, threshold: step.warnings };
    }
  }
  return chosen;
}

export async function nextCaseNumber(guildId: string): Promise<number> {
  const aggregate = await prisma.moderationCase.aggregate({
    where: { guildId },
    _max: { caseNumber: true },
  });
  return (aggregate._max.caseNumber ?? 0) + 1;
}

export interface CreateCaseInput {
  guildId: string;
  action: string;
  targetId: string;
  targetTag?: string | null;
  moderatorId: string;
  reason?: string | null;
  durationMs?: number | null;
  automated?: boolean;
  notes?: string | null;
  expiresAt?: Date | null;
}

/** Create a moderation case with a guild-unique case number (retries on race). */
export async function createCase(input: CreateCaseInput) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const caseNumber = await nextCaseNumber(input.guildId);
    try {
      return await prisma.moderationCase.create({
        data: {
          guildId: input.guildId,
          caseNumber,
          action: input.action,
          targetId: input.targetId,
          targetTag: input.targetTag ?? null,
          moderatorId: input.moderatorId,
          reason: input.reason ?? null,
          durationMs: input.durationMs ?? null,
          automated: input.automated ?? false,
          notes: input.notes ?? null,
          expiresAt: input.expiresAt ?? (input.durationMs ? new Date(Date.now() + input.durationMs) : null),
        },
      });
    } catch (error) {
      if (String(error).includes('Unique constraint')) continue;
      throw error;
    }
  }
  throw new Error('Could not allocate a moderation case number');
}

export async function createWarning(input: {
  guildId: string;
  targetId: string;
  moderatorId: string;
  reason: string;
  caseId?: string | null;
}) {
  const [warning] = await prisma.$transaction([
    prisma.warning.create({
      data: {
        guildId: input.guildId,
        targetId: input.targetId,
        moderatorId: input.moderatorId,
        reason: input.reason,
        caseId: input.caseId ?? null,
      },
    }),
  ]);
  return warning;
}

export async function activeWarnings(guildId: string, targetId: string) {
  return prisma.warning.findMany({
    where: { guildId, targetId, active: true },
    orderBy: { createdAt: 'desc' },
  });
}

export async function revokeWarning(guildId: string, warningId: string, revokedBy: string) {
  return prisma.warning.updateMany({
    where: { id: warningId, guildId },
    data: { active: false, revokedAt: new Date(), revokedBy },
  });
}

/** Warnings older than the configured retention window stop counting. */
export async function expireOldWarnings(guildId: string, days: number): Promise<number> {
  if (!days || days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const result = await prisma.warning.updateMany({
    where: { guildId, active: true, createdAt: { lt: cutoff } },
    data: { active: false, revokedAt: new Date(), revokedBy: 'system:expiry' },
  });
  return result.count;
}

export async function moderationStats(guildId: string) {
  const [byAction, byModerator, total, last7] = await Promise.all([
    prisma.moderationCase.groupBy({ by: ['action'], where: { guildId }, _count: { _all: true } }),
    prisma.moderationCase.groupBy({
      by: ['moderatorId'],
      where: { guildId },
      _count: { _all: true },
      orderBy: { _count: { moderatorId: 'desc' } },
      take: 10,
    }),
    prisma.moderationCase.count({ where: { guildId } }),
    prisma.moderationCase.count({ where: { guildId, createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } } }),
  ]);
  return {
    total,
    last7Days: last7,
    byAction: byAction.map((row) => ({ action: row.action, count: row._count._all })),
    topModerators: byModerator.map((row) => ({ moderatorId: row.moderatorId, count: row._count._all })),
  };
}

export async function listCases(
  guildId: string,
  options: { page?: number; pageSize?: number; targetId?: string; moderatorId?: string; action?: string; activeOnly?: boolean } = {},
) {
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 25));
  const where = {
    guildId,
    ...(options.targetId ? { targetId: options.targetId } : {}),
    ...(options.moderatorId ? { moderatorId: options.moderatorId } : {}),
    ...(options.action ? { action: options.action } : {}),
    ...(options.activeOnly ? { active: true } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.moderationCase.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.moderationCase.count({ where }),
  ]);
  return { items, total, page, pageSize };
}

export async function expiredActiveCases(limit = 50) {
  return prisma.moderationCase.findMany({
    where: { active: true, expiresAt: { not: null, lte: new Date() } },
    orderBy: { expiresAt: 'asc' },
    take: limit,
  });
}

export async function closeCase(caseId: string) {
  return prisma.moderationCase.update({ where: { id: caseId }, data: { active: false } });
}

export async function lastCaseFor(guildId: string, targetId: string) {
  return prisma.moderationCase.findFirst({ where: { guildId, targetId }, orderBy: { createdAt: 'desc' } });
}

export async function clientIsReady(_db: PrismaClient): Promise<boolean> {
  try {
    await _db.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
