/** Bot runtime configuration. */

import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_DEV_GUILD_ID: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  APP_ORIGIN: z.string().url().default('http://localhost:3000'),
  API_URL: z.string().url().default('http://127.0.0.1:4000'),
  LOG_LEVEL: z.string().default('info'),
  BOT_OWNER_IDS: z.string().optional(),
  YOUTUBE_API_KEY: z.string().optional(),
  TWITCH_CLIENT_ID: z.string().optional(),
  TWITCH_CLIENT_SECRET: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid bot environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = {
  nodeEnv: parsed.data.NODE_ENV,
  token: parsed.data.DISCORD_BOT_TOKEN ?? '',
  clientId: parsed.data.DISCORD_CLIENT_ID ?? '',
  devGuildId: parsed.data.DISCORD_DEV_GUILD_ID ?? '',
  redisUrl: parsed.data.REDIS_URL || null,
  appOrigin: parsed.data.APP_ORIGIN.replace(/\/$/, ''),
  apiUrl: parsed.data.API_URL.replace(/\/$/, ''),
  logLevel: parsed.data.LOG_LEVEL,
  ownerIds: (parsed.data.BOT_OWNER_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => /^\d{15,25}$/.test(value)),
  youtubeApiKey: parsed.data.YOUTUBE_API_KEY ?? '',
  twitch: { clientId: parsed.data.TWITCH_CLIENT_ID ?? '', clientSecret: parsed.data.TWITCH_CLIENT_SECRET ?? '' },
};

export const hasTwitchCredentials = Boolean(env.twitch.clientId && env.twitch.clientSecret);

export function requireToken(): string {
  if (!env.token) {
    console.error(
      [
        '',
        '  DISCORD_BOT_TOKEN is not configured.',
        '',
        '  1. Open https://discord.com/developers/applications',
        '  2. Create (or open) your application → Bot → Reset Token',
        '  3. Put it in .env as DISCORD_BOT_TOKEN=...',
        '  4. Enable the privileged intents: SERVER MEMBERS and MESSAGE CONTENT',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
  return env.token;
}
