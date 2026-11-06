/** API entry point: starts Fastify and handles graceful shutdown. */

import { disconnectDatabase, logger, recoverStuckJobs } from '@irh/db';
import { buildApp } from './app.js';
import { env } from './env.js';
import { pruneExpiredSessions } from './auth.js';

async function main(): Promise<void> {
  const app = await buildApp({ logger: false });
  const host = env.isProduction ? '0.0.0.0' : '127.0.0.1';

  await pruneExpiredSessions().catch(() => undefined);
  await recoverStuckJobs(5).catch(() => undefined);

  const housekeeping = setInterval(() => {
    void pruneExpiredSessions().catch((error) => logger.warn('api', 'Session cleanup failed', { error }));
  }, 3_600_000);
  housekeeping.unref();

  await app.listen({ port: env.port, host });
  logger.info('api', `REST API listening on http://${host}:${env.port}`, {
    origin: env.appOrigin,
    oauth: Boolean(env.discord.clientId && env.discord.clientSecret),
    botToken: Boolean(env.discord.botToken),
  });

  if (!env.discord.clientId || !env.discord.clientSecret) {
    logger.warn('api', 'Discord OAuth2 is not configured — the dashboard will show a setup notice until credentials are provided.');
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('api', `Received ${signal}; shutting down`);
    clearInterval(housekeeping);
    const timer = setTimeout(() => process.exit(1), 15_000);
    timer.unref();
    try {
      await app.close();
      await disconnectDatabase();
      process.exit(0);
    } catch (error) {
      logger.error('api', 'Shutdown failed', { error });
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error('api', 'Unhandled rejection', { reason }));
  process.on('uncaughtException', (error) => logger.error('api', 'Uncaught exception', { error }));
}

main().catch((error) => {
  logger.error('api', 'Failed to start API', { error });
  process.exit(1);
});
