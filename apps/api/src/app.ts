/** Fastify application factory (used by server.ts and the test suite). */

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { logger } from '@irh/db';
import { env } from './env.js';
import { csrfGuard } from './auth.js';
import { registerRealtime } from './realtime.js';
import { authRoutes } from './routes/auth.js';
import { guildRoutes } from './routes/guilds.js';
import { moderationRoutes } from './routes/moderation.js';
import { communityRoutes } from './routes/community.js';
import { automationRoutes } from './routes/automation.js';
import { systemRoutes } from './routes/system.js';

declare module 'fastify' {
  interface FastifyInstance {
    redis: unknown;
  }
}

export async function buildApp(options: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    disableRequestLogging: true,
  });

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginEmbedderPolicy: false });
  await app.register(cors, {
    origin: [env.appOrigin, env.apiUrl],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });
  await app.register(cookie, { secret: env.sessionSecret });
  await app.register(rateLimit, {
    max: env.nodeEnv === 'test' ? 10_000 : 400,
    timeWindow: '1 minute',
    allowList: (request) => request.url === '/health' || request.url === '/api/health',
    keyGenerator: (request) => (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || request.ip,
  });

  app.decorate('redis', null);

  app.addHook('onRequest', csrfGuard);
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    if (request.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(422).send({ error: 'validation_failed', message: 'Invalid request payload.', details: error.flatten() });
    }
    const status = typeof (error as { statusCode?: number }).statusCode === 'number' ? (error as { statusCode: number }).statusCode : 500;
    if (status >= 500) {
      logger.error('api', 'Unhandled request error', { method: request.method, url: request.url, error });
    }
    return reply.code(status).send({
      error: status >= 500 ? 'internal_error' : 'request_error',
      message: status >= 500 ? 'Something went wrong on our side.' : (error as Error).message,
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: 'not_found', message: `No route for ${request.method} ${request.url}` });
  });

  await registerRealtime(app);

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(guildRoutes);
      await api.register(moderationRoutes);
      await api.register(communityRoutes);
      await api.register(automationRoutes);
      await api.register(systemRoutes);
    },
    { prefix: '/api' },
  );

  app.get('/health', async () => ({ status: 'ok', uptime: Math.round(process.uptime()) }));

  return app;
}
