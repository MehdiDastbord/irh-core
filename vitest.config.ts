import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/**/tests/**/*.test.ts', 'packages/**/tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.next/**'],
    hookTimeout: 30_000,
    testTimeout: 20_000,
    pool: 'forks',
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'file:./test.db',
      SESSION_SECRET: 'test-session-secret-test-session-secret',
      ENCRYPTION_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
      DISCORD_CLIENT_ID: 'test-client',
      DISCORD_CLIENT_SECRET: 'test-secret',
      APP_ORIGIN: 'http://localhost:3000',
      LOG_LEVEL: 'silent',
    },
  },
  resolve: {
    alias: {
      '@irh/shared/feed': resolve(__dirname, 'packages/shared/src/feed.ts'),
      '@irh/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
      '@irh/db': resolve(__dirname, 'packages/db/src/index.ts'),
    },
  },
});
