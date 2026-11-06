// IRH CORE — Cloudflare Containers deployment.
//
// Workers cannot host a Discord gateway bot, so the whole stack (bot + API +
// dashboard) runs inside one Container image and this Worker proxies every
// request to it. A cron trigger pings the container every 5 minutes so the
// gateway connection is not dropped while nobody uses the dashboard.
//
//   npx wrangler secret put DATABASE_URL      # postgres://… (Neon, Aiven, RDS…)
//   npx wrangler secret put SESSION_SECRET
//   npx wrangler secret put ENCRYPTION_KEY
//   npx wrangler secret put DISCORD_CLIENT_ID
//   npx wrangler secret put DISCORD_CLIENT_SECRET
//   npx wrangler secret put DISCORD_BOT_TOKEN
//   npx wrangler secret put APP_ORIGIN        # https://irh-core.<subdomain>.workers.dev
//   npx wrangler deploy

import { Container, getContainer } from '@cloudflare/containers';

export interface Env {
  IRH_CONTAINER: DurableObjectNamespace<IrhCoreContainer>;
  APP_ORIGIN?: string;
  DATABASE_URL?: string;
  SESSION_SECRET?: string;
  ENCRYPTION_KEY?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_DEV_GUILD_ID?: string;
  BOT_OWNER_IDS?: string;
  REDIS_URL?: string;
  YOUTUBE_API_KEY?: string;
  TWITCH_CLIENT_ID?: string;
  TWITCH_CLIENT_SECRET?: string;
}

// One instance only: the bot holds a single gateway connection and every
// dashboard request must reach the process that owns the Prisma pool.
const INSTANCE = 'irh-core';
const APP_PORT = 3000;
const API_PORT = 4000;

const PASSTHROUGH = [
  'DATABASE_URL',
  'APP_ORIGIN',
  'SESSION_SECRET',
  'ENCRYPTION_KEY',
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_BOT_TOKEN',
  'DISCORD_DEV_GUILD_ID',
  'BOT_OWNER_IDS',
  'REDIS_URL',
  'YOUTUBE_API_KEY',
  'TWITCH_CLIENT_ID',
  'TWITCH_CLIENT_SECRET',
] as const;

export class IrhCoreContainer extends Container<Env> {
  defaultPort = APP_PORT;
  requiredPorts = [APP_PORT];
  // Keep the container (and therefore the Discord gateway) alive between
  // dashboard visits; the cron trigger below renews the activity timer.
  sleepAfter = '23h';
  enableInternet = true;
  pingEndpoint = `localhost/api/irh/system/health`;
  envVars = containerEnv(this.env);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return getContainer(env.IRH_CONTAINER, INSTANCE).fetch(request);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(keepAlive(env));
  },
};

async function keepAlive(env: Env): Promise<void> {
  try {
    const response = await getContainer(env.IRH_CONTAINER, INSTANCE).fetch(
      `http://container/api/irh/system/health`,
    );
    await response.body?.cancel();
  } catch (error) {
    console.error('[scheduled] container keep-alive failed', error);
  }
}

function containerEnv(env: Env): Record<string, string> {
  const values: Record<string, string> = {
    NODE_ENV: 'production',
    API_PORT: String(API_PORT),
    // The dashboard proxies /api/irh/* to this loopback address.
    API_URL: `http://127.0.0.1:${API_PORT}`,
    WEB_PORT: String(APP_PORT),
  };
  const source = env as unknown as Record<string, unknown>;
  for (const key of PASSTHROUGH) {
    const value = source[key];
    if (typeof value === 'string' && value.trim().length > 0) values[key] = value;
  }
  return values;
}
