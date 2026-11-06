/** Guild settings access with defaults, validation and audit trails. */

import { validateModulePatch, validateModuleSettings, moduleById, MODULES } from '@irh/shared';
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from './index.js';
import { logger } from './logger.js';

type Db = PrismaClient | Prisma.TransactionClient;

export type GuildSettingsMap = Record<string, Record<string, unknown>>;

export async function getModuleSettings<T = Record<string, unknown>>(guildId: string, moduleId: string, db: Db = prisma): Promise<T> {
  const row = await db.guildSetting.findUnique({ where: { guildId_moduleId: { guildId, moduleId } } });
  const stored = row?.data ?? {};
  const result = validateModuleSettings(moduleId, stored);
  if (!result.ok) {
    logger.warn('settings', `Invalid stored settings for ${moduleId}; falling back to defaults`, {
      guildId,
      errors: result.errors,
    });
    const fallback = validateModuleSettings(moduleId, {});
    return (fallback.ok ? fallback.data : {}) as T;
  }
  return result.data as T;
}

export async function getAllSettings(guildId: string, db: Db = prisma): Promise<GuildSettingsMap> {
  const rows = await db.guildSetting.findMany({ where: { guildId } });
  const map: GuildSettingsMap = {};
  for (const module of MODULES) {
    const row = rows.find((candidate) => candidate.moduleId === module.id);
    const validated = validateModuleSettings(module.id, row?.data ?? {});
    map[module.id] = validated.ok ? validated.data : {};
  }
  return map;
}

export interface SaveSettingsResult {
  ok: boolean;
  errors?: Record<string, string[]>;
  data?: Record<string, unknown>;
}

export async function saveModuleSettings(
  guildId: string,
  moduleId: string,
  patch: unknown,
  options: { actorId?: string; mode?: 'merge' | 'replace'; db?: Db } = {},
): Promise<SaveSettingsResult> {
  if (!moduleById(moduleId)) return { ok: false, errors: { module: ['Unknown module'] } };
  const db = options.db ?? prisma;
  const mode = options.mode ?? 'merge';

  let next: Record<string, unknown>;
  if (mode === 'replace') {
    const validated = validateModuleSettings(moduleId, patch);
    if (!validated.ok) return { ok: false, errors: validated.errors };
    next = validated.data;
  } else {
    const current = await getModuleSettings(guildId, moduleId, db);
    const validated = validateModulePatch(moduleId, patch);
    if (!validated.ok) return { ok: false, errors: validated.errors };
    const merged = validateModuleSettings(moduleId, { ...current, ...validated.data });
    if (!merged.ok) return { ok: false, errors: merged.errors };
    next = merged.data;
  }

  const existing = await db.guildSetting.findUnique({ where: { guildId_moduleId: { guildId, moduleId } } });
  const row = await db.guildSetting.upsert({
    where: { guildId_moduleId: { guildId, moduleId } },
    create: { guildId, moduleId, data: next as Prisma.InputJsonValue },
    update: { data: next as Prisma.InputJsonValue },
  });

  await db.auditRecord.create({
    data: {
      guildId,
      actorId: options.actorId ?? null,
      actorType: options.actorId ? 'user' : 'system',
      action: 'settings.update',
      targetType: 'module',
      targetId: moduleId,
      before: (existing?.data ?? undefined) as Prisma.InputJsonValue | undefined,
      after: next as Prisma.InputJsonValue,
    },
  });

  logger.info('settings', 'Module settings saved', { guildId, moduleId, actorId: options.actorId });
  return { ok: true, data: (row.data as Record<string, unknown>) ?? next };
}

export async function ensureGuild(guild: {
  id: string;
  name: string;
  icon?: string | null;
  ownerId?: string | null;
  memberCount?: number;
}, db: Db = prisma) {
  return db.guild.upsert({
    where: { discordId: guild.id },
    create: {
      discordId: guild.id,
      name: guild.name,
      icon: guild.icon ?? null,
      ownerId: guild.ownerId ?? null,
      memberCount: guild.memberCount ?? 0,
    },
    update: {
      name: guild.name,
      icon: guild.icon ?? null,
      ownerId: guild.ownerId ?? null,
      ...(guild.memberCount === undefined ? {} : { memberCount: guild.memberCount }),
    },
  });
}

export async function guildIdFor(discordGuildId: string): Promise<string | null> {
  const row = await prisma.guild.findUnique({ where: { discordId: discordGuildId }, select: { id: true } });
  return row?.id ?? null;
}

/** Resolve the internal guild id, creating the guild row when the bot is present. */
export async function requireGuildId(discordGuildId: string): Promise<string> {
  const existing = await guildIdFor(discordGuildId);
  if (existing) return existing;
  const created = await prisma.guild.create({ data: { discordId: discordGuildId, name: 'Unknown guild' } });
  return created.id;
}
