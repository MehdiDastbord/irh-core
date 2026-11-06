/** Tiny registry so scheduled jobs and modules can reach the client without cycles. */

import type { Client } from 'discord.js';

let clientRef: Client | null = null;

export function setClient(client: Client): void {
  clientRef = client;
}

export function getClient(): Client | null {
  return clientRef;
}
