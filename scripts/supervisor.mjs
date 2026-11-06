#!/usr/bin/env node
/**
 * IRH CORE supervisor — one process tree for API + dashboard (+ bot when configured).
 *
 * Designed for 24/7 container/VM hosting: restarts crashed services with
 * exponential backoff, never restarts during shutdown, and forwards SIGTERM/SIGINT
 * so Prisma connections close cleanly.
 *
 *   npm run start:all
 *
 * Environment:
 *   API_PORT (default 4000)  WEB_PORT (default 3000)  DISCORD_BOT_TOKEN (optional)
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const node = process.execPath;
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const nextCli = join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
const webPort = process.env.WEB_PORT ?? '3000';
const hasBuild = existsSync(join(root, 'apps', 'web', '.next', 'BUILD_ID'));
const hasToken = Boolean(process.env.DISCORD_BOT_TOKEN);

if (!existsSync(tsxCli)) {
  console.error('[supervisor] tsx is not installed. Run `npm ci` first.');
  process.exit(1);
}

const services = [
  {
    name: 'api',
    args: [tsxCli, join(root, 'apps', 'api', 'src', 'server.ts')],
    enabled: true,
  },
  {
    name: 'web',
    args: [nextCli, 'start', '-p', webPort],
    enabled: hasBuild,
    skipReason: 'apps/web/.next/BUILD_ID is missing — run `npm run build -w @irh/web`',
  },
  {
    name: 'bot',
    args: [tsxCli, join(root, 'apps', 'bot', 'src', 'index.ts')],
    enabled: hasToken,
    skipReason: 'DISCORD_BOT_TOKEN is not set — dashboard-only mode',
  },
];

const running = new Map();
let stopping = false;
let started = 0;

function prefix(name, chunk) {
  const text = String(chunk);
  return text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => `[${name}] ${line}\n`)
    .join('');
}

function start(service) {
  const child = spawn(node, service.args, {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.set(service.name, child);
  started += 1;
  child.stdout.on('data', (chunk) => process.stdout.write(prefix(service.name, chunk)));
  child.stderr.on('data', (chunk) => process.stderr.write(prefix(service.name, chunk)));

  child.on('error', (error) => {
    console.error(`[supervisor] ${service.name} failed to spawn: ${error.message}`);
  });

  child.on('exit', (code, signal) => {
    running.delete(service.name);
    if (stopping) return;
    service.restarts = (service.restarts ?? 0) + 1;
    if (service.restarts > 15) {
      console.error(`[supervisor] ${service.name} crashed ${service.restarts} times — leaving it stopped. Other services keep running.`);
      return;
    }
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(service.restarts - 1, 5));
    console.error(`[supervisor] ${service.name} exited (code=${code ?? 'null'} signal=${signal ?? 'none'}); restarting in ${Math.round(delay / 1000)}s`);
    setTimeout(() => {
      if (!stopping) start(service);
    }, delay);
  });
}

for (const service of services) {
  if (service.enabled) {
    console.log(`[supervisor] starting ${service.name}`);
    start(service);
    // Stagger startup so the API binds first and the dashboard proxy is warm.
    await new Promise((resolve) => setTimeout(resolve, 800));
  } else {
    console.warn(`[supervisor] ${service.name} disabled: ${service.skipReason}`);
  }
}

if (started === 0) {
  console.error('[supervisor] nothing to start.');
  process.exit(1);
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[supervisor] received ${signal}; stopping ${running.size} service(s)`);
  for (const [name, child] of running) {
    console.log(`[supervisor] stopping ${name}`);
    child.kill('SIGTERM');
  }
  const force = setTimeout(() => {
    console.error('[supervisor] shutdown timed out — forcing exit');
    process.exit(1);
  }, 15_000);
  force.unref();

  const wait = setInterval(() => {
    if (running.size === 0) {
      clearInterval(wait);
      console.log('[supervisor] all services stopped');
      process.exit(0);
    }
  }, 200);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (error) => console.error('[supervisor] uncaught exception', error));
process.on('unhandledRejection', (reason) => console.error('[supervisor] unhandled rejection', reason));
