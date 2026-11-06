#!/usr/bin/env node
// Generates prisma/schema.sqlite.prisma from the canonical PostgreSQL schema and
// runs `prisma generate` (and optionally `prisma db push`) against it.
//
// The canonical schema (prisma/schema.prisma) stays PostgreSQL for production.
// SQLite is used for local development, automated tests and air-gapped demos
// where no PostgreSQL server is available. No enums or scalar lists are used in
// the schema so the same models run on both providers.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const canonical = join(root, 'prisma', 'schema.prisma');
const sqliteSchema = join(root, 'prisma', 'schema.sqlite.prisma');
const planted = join(root, 'node_modules', '.prisma', 'client', 'schema.prisma');
const args = new Set(process.argv.slice(2));

const databaseUrl =
  process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('file:')
    ? process.env.DATABASE_URL
    : process.env.DATABASE_URL && !process.env.IRH_FORCE_SQLITE
      ? process.env.DATABASE_URL
      : 'file:./irh-core.db';

const source = readFileSync(canonical, 'utf8');
const alreadySqlite = existsSync(planted) && readFileSync(planted, 'utf8').includes('provider = "sqlite"');
const wantsPostgres = process.env.DATABASE_URL?.startsWith('postgres') && !process.env.IRH_FORCE_SQLITE;

const prismaCli = join(root, 'node_modules', 'prisma', 'build', 'index.js');

if (wantsPostgres) {
  console.log('[db] Using PostgreSQL schema (DATABASE_URL is postgres://).');
  run(['generate', '--schema', canonical]);
  if (args.has('--push')) run(['db', 'push', '--schema', canonical, '--skip-generate']);
  process.exit(0);
}

const sqliteSource = source
  .replace('provider = "postgresql"', 'provider = "sqlite"')
  .replace(/url\s+=\s+env\("DATABASE_URL"\)/, `url      = "${databaseUrl}"`);

writeFileSync(sqliteSchema, sqliteSource);
console.log(`[db] Generated ${sqliteSchema} (${databaseUrl}).`);
run(['generate', '--schema', sqliteSchema]);
if (args.has('--push')) {
  run(['db', 'push', '--schema', sqliteSchema, '--skip-generate', ...(args.has('--reset') ? ['--force-reset'] : [])]);
}
if (!alreadySqlite) console.log('[db] SQLite client generated.');

// Run the Prisma CLI through Node directly: spawning `npx` with shell:true breaks
// when the project path contains spaces ("MANAGEMENT BOT").
function run(argv) {
  const result = spawnSync(process.execPath, [prismaCli, ...argv], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    console.error(`[db] Command failed: prisma ${argv.join(' ')}`);
    process.exit(result.status ?? 1);
  }
}
