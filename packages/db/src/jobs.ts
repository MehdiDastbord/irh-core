/**
 * Persistent scheduled jobs with exponential backoff and idempotent claiming.
 * Works with PostgreSQL in production; no Redis required (BullMQ is optional).
 */

import type { Prisma } from '@prisma/client';
import { prisma } from './client.js';
import { logger } from './logger.js';
import { backoffDelay } from '@irh/shared';

export interface EnqueueInput {
  type: string;
  payload?: unknown;
  runAt?: Date;
  guildId?: string | null;
  priority?: number;
  maxAttempts?: number;
  dedupeKey?: string | null;
}

export async function enqueueJob(input: EnqueueInput) {
  try {
    return await prisma.scheduledJob.upsert({
      where: { dedupeKey: input.dedupeKey ?? `__none__:${crypto.randomUUID()}` },
      create: {
        type: input.type,
        payload: (input.payload ?? {}) as Prisma.InputJsonValue,
        runAt: input.runAt ?? new Date(),
        guildId: input.guildId ?? null,
        priority: input.priority ?? 0,
        maxAttempts: input.maxAttempts ?? 5,
        dedupeKey: input.dedupeKey ?? null,
      },
      update: {
        runAt: input.runAt ?? new Date(),
        status: 'pending',
      },
    });
  } catch (error) {
    logger.error('jobs', 'Failed to enqueue job', { type: input.type, error });
    throw error;
  }
}

/** Cancel a pending job by dedupe key (used when a giveaway is deleted etc.). */
export async function cancelJob(dedupeKey: string) {
  await prisma.scheduledJob.updateMany({ where: { dedupeKey, status: 'pending' }, data: { status: 'cancelled', completedAt: new Date() } });
}

/**
 * Atomically claim due jobs. Uses a transaction with a status guard so two
 * workers never process the same job.
 */
export async function claimDueJobs(limit = 10, workerId = 'worker') {
  const now = new Date();
  const candidates = await prisma.scheduledJob.findMany({
    where: { status: 'pending', runAt: { lte: now } },
    orderBy: [{ priority: 'desc' }, { runAt: 'asc' }],
    take: limit,
  });
  const claimed: typeof candidates = [];
  for (const job of candidates) {
    const result = await prisma.scheduledJob.updateMany({
      where: { id: job.id, status: 'pending' },
      data: { status: 'running', startedAt: new Date(), attempts: { increment: 1 }, lastError: null },
    });
    if (result.count === 1) claimed.push(job);
  }
  if (claimed.length) logger.debug('jobs', `Claimed ${claimed.length} job(s)`, { workerId });
  return claimed;
}

export async function completeJob(jobId: string) {
  await prisma.scheduledJob.update({
    where: { id: jobId },
    data: { status: 'completed', completedAt: new Date() },
  });
}

/**
 * Mark a job failed. Retries with exponential backoff until maxAttempts, then
 * leaves it in `failed` for inspection from the dashboard.
 */
export async function failJob(jobId: string, error: unknown) {
  const job = await prisma.scheduledJob.findUnique({ where: { id: jobId } });
  if (!job) return;
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = job.attempts >= job.maxAttempts;
  await prisma.scheduledJob.update({
    where: { id: jobId },
    data: {
      status: exhausted ? 'failed' : 'pending',
      lastError: message.slice(0, 1000),
      runAt: exhausted ? job.runAt : new Date(Date.now() + backoffDelay(job.attempts)),
      completedAt: exhausted ? new Date() : null,
    },
  });
  if (exhausted) logger.error('jobs', 'Job permanently failed', { jobId, type: job.type, attempts: job.attempts, error: message });
  else logger.warn('jobs', 'Job will retry', { jobId, type: job.type, attempt: job.attempts, error: message });
}

/** Recover jobs left `running` by a crashed process. */
export async function recoverStuckJobs(olderThanMinutes = 10): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  const result = await prisma.scheduledJob.updateMany({
    where: { status: 'running', startedAt: { lt: cutoff } },
    data: { status: 'pending', runAt: new Date() },
  });
  if (result.count) logger.warn('jobs', `Recovered ${result.count} stuck job(s)`);
  return result.count;
}

export async function jobStats() {
  const rows = await prisma.scheduledJob.groupBy({ by: ['status'], _count: { _all: true } });
  return Object.fromEntries(rows.map((row) => [row.status, row._count._all]));
}

export async function pendingJobCount(): Promise<number> {
  return prisma.scheduledJob.count({ where: { status: { in: ['pending', 'running'] } } });
}
