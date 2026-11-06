/** Validated runtime configuration for the REST API. */

import 'dotenv/config';
import { z } from 'zod';
import { logger } from '@irh/db';

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  APP_ORIGIN: z.string().url().default('http://localhost:3000'),
  API_URL: z.string().url().default('http://127.0.0.1:4000'),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  SESSION_SECRET: z.string().min(16).optional(),
  ENCRYPTION_KEY: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_CLIENT_SECRET: z.string().optional(),
  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_DEV_GUILD_ID: z.string().optional(),
  BOT_OWNER_IDS: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}
const raw = parsed.data;

const sessionSecret = raw.SESSION_SECRET ?? '';
if (!sessionSecret) {
  logger.warn('env', 'SESSION_SECRET is not set — generating an ephemeral secret. Sessions will not survive a restart.');
}
if (raw.NODE_ENV === 'production' && !sessionSecret) {
  throw new Error('SESSION_SECRET is required in production');
}

export const env = {
  nodeEnv: raw.NODE_ENV,
  isProduction: raw.NODE_ENV === 'production',
  port: raw.API_PORT,
  appOrigin: raw.APP_ORIGIN.replace(/\/$/, ''),
  apiUrl: raw.API_URL.replace(/\/$/, ''),
  redisUrl: raw.REDIS_URL || null,
  sessionSecret: sessionSecret || 'dev-only-ephemeral-session-secret-change-me',
  encryptionKey: raw.ENCRYPTION_KEY ?? '',
  logLevel: raw.LOG_LEVEL,
  discord: {
    clientId: raw.DISCORD_CLIENT_ID ?? '',
    clientSecret: raw.DISCORD_CLIENT_SECRET ?? '',
    botToken: raw.DISCORD_BOT_TOKEN ?? '',
    devGuildId: raw.DISCORD_DEV_GUILD_ID ?? '',
    redirectUri: `${raw.APP_ORIGIN.replace(/\/$/, '')}/api/irh/auth/callback`,
  },
  botOwnerIds: (raw.BOT_OWNER_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => /^\d{15,25}$/.test(value)),
};

export const oauthConfigured = Boolean(env.discord.clientId && env.discord.clientSecret);
export const botConfigured = Boolean(env.discord.botToken);
