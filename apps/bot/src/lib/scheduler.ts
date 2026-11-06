/**
 * Persistent job scheduler.
 *
 * Jobs live in the database (ScheduledJob) so they survive restarts and are
 * processed with at-least-once semantics plus idempotency keys. When REDIS_URL
 * is configured, BullMQ drives the tick as a distributed repeatable job so
 * multiple instances do not duplicate work; otherwise a local interval is used.
 * Either way the durable queue of record is Postgres.
 */

import { Worker, Queue } from 'bullmq';
import IORedis from 'ioredis';
import {
  claimDueJobs,
  completeJob,
  failJob,
  logger,
  prisma,
  recoverStuckJobs,
} from '@irh/db';
import type { Client } from 'discord.js';
import { env } from '../env.js';

const log = logger.child('scheduler');

export type JobHandler = (payload: Record<string, unknown>, job: { id: string; guildId: string | null; type: string }) => Promise<void>;

const handlers = new Map<string, JobHandler>();

export function registerJobHandler(type: string, handler: JobHandler): void {
  handlers.set(type, handler);
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private redis: IORedis | null = null;
  private queue: Queue | null = null;
  private worker: Worker | null = null;
  private stopping = false;

  constructor(private readonly client: Client) {}

  async start(): Promise<void> {
    await recoverStuckJobs(10).catch((error) => log.warn('Recovery failed', { error: String(error) }));
    await this.startBullMqDriver();
    this.timer = setInterval(() => void this.tick(), 5_000);
    this.timer.unref();
    log.info('Scheduler started', { drivers: this.worker ? ['redis', 'database'] : ['database'] });
    void this.tick();
  }

  /** BullMQ only orchestrates the tick; jobs remain durable in Postgres. */
  private async startBullMqDriver(): Promise<void> {
    if (!env.redisUrl) return;
    try {
      this.redis = new IORedis(env.redisUrl, { maxRetriesPerRequest: null, lazyConnect: false });
      this.redis.on('error', (error) => log.warn('Redis error', { error: String(error) }));
      this.queue = new Queue('irh-scheduler', { connection: this.redis });
      await this.queue.upsertJobScheduler('irh-tick', { every: 5_000 }, { name: 'tick', data: {} });
      this.worker = new Worker(
        'irh-scheduler',
        async () => {
          await this.tick();
        },
        { connection: this.redis, concurrency: 1 },
      );
      this.worker.on('failed', (_job, error) => log.warn('Scheduler tick failed', { error: String(error) }));
      log.info('BullMQ scheduler driver active', { queue: 'irh-scheduler' });
    } catch (error) {
      log.warn('Redis unavailable — falling back to the database scheduler', { error: String(error) });
      this.redis = null;
      this.queue = null;
      this.worker = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopping) return;
    this.running = true;
    try {
      const jobs = await claimDueJobs(15, `bot-${this.client.user?.id ?? 'starting'}`);
      for (const job of jobs) {
        if (this.stopping) break;
        const handler = handlers.get(job.type);
        if (!handler) {
          await failJob(job.id, `No handler registered for job type ${job.type}`);
          continue;
        }
        const started = Date.now();
        try {
          await handler((job.payload as Record<string, unknown>) ?? {}, { id: job.id, guildId: job.guildId, type: job.type });
          await completeJob(job.id);
          log.debug('Job completed', { type: job.type, jobId: job.id, ms: Date.now() - started });
        } catch (error) {
          await failJob(job.id, error);
        }
      }
    } catch (error) {
      log.error('Scheduler tick crashed', { error: String(error) });
    } finally {
      this.running = false;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
    if (this.redis) await this.redis.quit().catch(() => undefined);
    // Release in-flight claims so another instance can retry immediately.
    await prisma.scheduledJob.updateMany({ where: { status: 'running' }, data: { status: 'pending', runAt: new Date() } }).catch(() => undefined);
    log.info('Scheduler stopped');
  }
}
