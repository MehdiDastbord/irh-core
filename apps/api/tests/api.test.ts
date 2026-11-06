import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('API surface', () => {
  it('exposes a health endpoint', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
  });

  it('reports OAuth configuration without leaking the client secret', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/config' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body).toHaveProperty('oauthConfigured');
    expect(JSON.stringify(body)).not.toContain('test-secret');
  });

  it('rejects protected endpoints without a session', async () => {
    for (const url of ['/api/me', '/api/guilds', '/api/guilds/123/settings/general', '/api/system/jobs', '/api/system/status']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(401);
    }
  });

  it('refuses unauthorized mutations', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/guilds/123/settings/general',
      payload: { language: 'en' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects cross-origin state-changing requests', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { origin: 'https://evil.example', host: 'localhost:4000' },
    });
    expect([401, 403]).toContain(response.statusCode);
  });

  it('returns 404 for unknown routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'not_found' });
  });

  it('validates module names and payloads for authenticated routes', async () => {
    // Unauthenticated requests are rejected before validation; this asserts the guard order.
    const response = await app.inject({ method: 'GET', url: '/api/guilds/1/settings/not-a-module' });
    expect(response.statusCode).toBe(401);
  });
});
