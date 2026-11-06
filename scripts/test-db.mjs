#!/usr/bin/env node
// Prepares an isolated SQLite database for `vitest` runs.
// Keeps the developer's local database untouched.

import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
process.env.IRH_FORCE_SQLITE = '1';
process.env.DATABASE_URL = 'file:./test.db';

const dbFile = join(root, 'prisma', 'test.db');
for (const suffix of ['', '-journal', '-wal', '-shm']) {
  rmSync(dbFile + suffix, { force: true });
}

const generate = spawnSync(process.execPath, [join(root, 'scripts', 'db-provider.mjs'), '--push', '--reset'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, IRH_FORCE_SQLITE: '1', DATABASE_URL: 'file:./test.db' },
});
if (generate.status !== 0) process.exit(generate.status ?? 1);
console.log('[test] Test database ready.');
