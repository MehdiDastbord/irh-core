/** In-process realtime hub (WebSocket) with ticket authentication. */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { env } from './env.js';
import { logger } from '@irh/db';

export interface RealtimeEvent {
  type: string;
  guildId?: string | null;
  payload?: unknown;
  ts?: string;
}

interface Client {
  socket: { send: (data: string) => void; close: () => void; readyState: number };
  userId: string;
  guildIds: Set<string>;
}

const clients = new Set<Client>();

export function issueTicket(userId: string, guildIds: string[]): string {
  const payload = Buffer.from(JSON.stringify({ userId, guildIds, exp: Date.now() + 60_000 })).toString('base64url');
  const signature = createHmac('sha256', env.sessionSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyTicket(ticket: string | undefined): { userId: string; guildIds: string[] } | null {
  if (!ticket) return null;
  const [payload, signature] = ticket.split('.');
  if (!payload || !signature) return null;
  const expected = createHmac('sha256', env.sessionSecret).update(payload).digest('base64url');
  if (expected.length !== signature.length) return null;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { userId: string; guildIds: string[]; exp: number };
    if (!data.exp || data.exp < Date.now()) return null;
    return { userId: data.userId, guildIds: data.guildIds ?? [] };
  } catch {
    return null;
  }
}

export function broadcast(event: RealtimeEvent): void {
  const message = JSON.stringify({ ...event, ts: event.ts ?? new Date().toISOString() });
  let sent = 0;
  for (const client of clients) {
    if (event.guildId && !client.guildIds.has(event.guildId)) continue;
    try {
      client.socket.send(message);
      sent += 1;
    } catch {
      clients.delete(client);
    }
  }
  if (sent) logger.debug('realtime', `Broadcast ${event.type}`, { clients: sent });
}

export function connectionCount(): number {
  return clients.size;
}

export async function registerRealtime(app: FastifyInstance): Promise<void> {
  await app.register(websocket);

  app.get('/ws', { websocket: true }, (socket, request) => {
    const url = new URL(request.url, env.appOrigin);
    const ticket = verifyTicket(url.searchParams.get('ticket') ?? undefined);
    if (!ticket) {
      socket.close();
      return;
    }
    const client: Client = {
      socket: socket as unknown as Client['socket'],
      userId: ticket.userId,
      guildIds: new Set(ticket.guildIds),
    };
    clients.add(client);
    client.socket.send(JSON.stringify({ type: 'hello', userId: client.userId, ts: new Date().toISOString() }));

    const heartbeat = setInterval(() => {
      try {
        client.socket.send(JSON.stringify({ type: 'ping', ts: new Date().toISOString() }));
      } catch {
        clearInterval(heartbeat);
        clients.delete(client);
      }
    }, 25_000);

    socket.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(client);
    });
    socket.on('error', () => {
      clearInterval(heartbeat);
      clients.delete(client);
    });
  });
}
