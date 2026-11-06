/** Short-lived guild settings cache shared by hot paths (messages, joins). */

import { getModuleSettings, logger, prisma, requireGuildId, ensureGuild } from '@irh/db';
import type { Guild } from 'discord.js';

interface Entry {
  value: Record<string, unknown>;
  expiresAt: number;
}

const CACHE_TTL_MS = 15_000;
const cache = new Map<string, Entry>();

const loggerScope = logger.child('settings');

export function invalidateSettings(guildId?: string): void {
  if (!guildId) cache.clear();
  else {
    for (const key of cache.keys()) {
      if (key.startsWith(`${guildId}:`)) cache.delete(key);
    }
  }
}

export function invalidateAllSettings(): void {
  cache.clear();
}

/** Typed settings access with defaults from the shared registry. */
export async function settings<T = Record<string, unknown>>(guildId: string, moduleId: string): Promise<T> {
  const key = `${guildId}:${moduleId}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value as T;
  const internalId = await requireGuildId(guildId);
  const value = (await getModuleSettings(internalId, moduleId)) as Record<string, unknown>;
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value as T;
}

export async function internalGuildId(discordGuildId: string): Promise<string> {
  return requireGuildId(discordGuildId);
}

export async function registerGuild(guild: Guild): Promise<string> {
  const record = await ensureGuild({
    id: guild.id,
    name: guild.name,
    icon: guild.icon,
    ownerId: guild.ownerId,
    memberCount: guild.memberCount,
  });
  cache.delete(`${guild.id}:general`);
  return record.id;
}

export async function isModuleEnabled(guildId: string, moduleId: string): Promise<boolean> {
  const value = await settings<{ enabled?: boolean }>(guildId, moduleId);
  return value.enabled !== false;
}

export async function moduleSettingsOrNull<T = Record<string, unknown>>(guildId: string, moduleId: string): Promise<T | null> {
  try {
    return await settings<T>(guildId, moduleId);
  } catch (error) {
    loggerScope.warn(`Failed to load ${moduleId} settings`, { error: String(error) });
    return null;
  }
}

export async function markGuildLeft(discordGuildId: string): Promise<void> {
  await prisma.guild.updateMany({ where: { discordId: discordGuildId }, data: { botJoinedAt: new Date(0) } });
  invalidateSettings(discordGuildId);
}
