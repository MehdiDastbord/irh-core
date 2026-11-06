/** Guild backups: snapshot configuration and restore it safely. */

import type { Prisma } from '@prisma/client';
import { prisma } from './client.js';
import { logger } from './logger.js';

export interface BackupSnapshot {
  version: 1;
  createdAt: string;
  guild: { discordId: string; name: string; icon: string | null };
  settings: { moduleId: string; data: unknown }[];
  logging: unknown[];
  reactionRoles: unknown[];
  ticketPanels: unknown[];
  levelRewards: unknown[];
  customCommands: unknown[];
  autoReactions: unknown[];
  inviteRewards: unknown;
  counters: unknown[];
}

export async function createBackup(input: {
  guildId: string;
  name: string;
  createdById?: string | null;
  includeMembers?: boolean;
}): Promise<{ id: string; sizeBytes: number }> {
  const guild = await prisma.guild.findUnique({ where: { id: input.guildId } });
  if (!guild) throw new Error('Guild not found');

  const [settings, logging, reactionRoles, ticketPanels, levelRewards, customCommands, autoReactions, invites, counters, members] =
    await Promise.all([
      prisma.guildSetting.findMany({ where: { guildId: input.guildId } }),
      prisma.loggingConfiguration.findMany({ where: { guildId: input.guildId } }),
      prisma.reactionRolePanel.findMany({ where: { guildId: input.guildId } }),
      prisma.ticketPanel.findMany({ where: { guildId: input.guildId } }),
      prisma.levelReward.findMany({ where: { guildId: input.guildId } }),
      prisma.customCommand.findMany({ where: { guildId: input.guildId } }),
      prisma.autoReactionRule.findMany({ where: { guildId: input.guildId } }),
      prisma.guildSetting.findUnique({ where: { guildId_moduleId: { guildId: input.guildId, moduleId: 'invites' } } }),
      prisma.counterChannel.findMany({ where: { guildId: input.guildId } }),
      input.includeMembers
        ? prisma.guildMember.findMany({ where: { guildId: input.guildId, leftAt: null }, take: 5000 })
        : Promise.resolve([]),
    ]);

  const snapshot: BackupSnapshot & { members?: unknown[] } = {
    version: 1,
    createdAt: new Date().toISOString(),
    guild: { discordId: guild.discordId, name: guild.name, icon: guild.icon },
    settings: settings.map((row) => ({ moduleId: row.moduleId, data: row.data })),
    logging: logging.map((row) => ({
      event: row.event,
      enabled: row.enabled,
      channelIds: row.channelIds,
      color: row.color,
      ignoreRoleIds: row.ignoreRoleIds,
      ignoreChannelIds: row.ignoreChannelIds,
    })),
    reactionRoles: reactionRoles.map((row) => ({ name: row.name, channelId: row.channelId, mode: row.mode, options: row.options })),
    ticketPanels: ticketPanels.map((row) => ({
      name: row.name,
      description: row.description,
      categoryId: row.categoryId,
      supportRoleIds: row.supportRoleIds,
      formFields: row.formFields,
    })),
    levelRewards: levelRewards.map((row) => ({ level: row.level, roleId: row.roleId, removeOnLower: row.removeOnLower })),
    customCommands: customCommands.map((row) => ({ name: row.name, response: row.response, embed: row.embed })),
    autoReactions: autoReactions.map((row) => ({ triggerType: row.triggerType, pattern: row.pattern, emojis: row.emojis })),
    inviteRewards: invites?.data ?? {},
    counters: counters.map((row) => ({ channelId: row.channelId, type: row.type, template: row.template })),
    members: members.map((member) => ({ discordId: member.discordId, joinedAt: member.joinedAt })),
  };

  const serialized = JSON.stringify(snapshot);
  const record = await prisma.backup.create({
    data: {
      guildId: input.guildId,
      name: input.name.slice(0, 120),
      data: snapshot as unknown as Prisma.InputJsonValue,
      sizeBytes: Buffer.byteLength(serialized, 'utf8'),
      createdById: input.createdById ?? null,
    },
  });
  logger.info('backup', 'Backup created', { guildId: input.guildId, backupId: record.id, sizeBytes: record.sizeBytes });
  return { id: record.id, sizeBytes: record.sizeBytes };
}

export interface RestoreResult {
  restoredModules: string[];
  restoredLogging: number;
  restoredPanels: number;
  warnings: string[];
}

/** Restore a backup into the same guild. Only settings/panels are restored here;
 * role/channel recreation is handled by the bot with the returned snapshot. */
export async function restoreBackup(input: {
  guildId: string;
  backupId: string;
  actorId?: string | null;
}): Promise<RestoreResult> {
  const backup = await prisma.backup.findFirst({ where: { id: input.backupId, guildId: input.guildId } });
  if (!backup) throw new Error('Backup not found');
  const snapshot = backup.data as unknown as BackupSnapshot;
  if (snapshot?.version !== 1) throw new Error('Unsupported backup version');

  const warnings: string[] = [];
  const restoredModules: string[] = [];

  await prisma.$transaction(async (tx) => {
    for (const entry of snapshot.settings ?? []) {
      await tx.guildSetting.upsert({
        where: { guildId_moduleId: { guildId: input.guildId, moduleId: entry.moduleId } },
        create: { guildId: input.guildId, moduleId: entry.moduleId, data: entry.data as Prisma.InputJsonValue },
        update: { data: entry.data as Prisma.InputJsonValue },
      });
      restoredModules.push(entry.moduleId);
    }
    for (const entry of snapshot.logging ?? []) {
      const config = entry as { event: string; enabled: boolean; channelIds: unknown };
      await tx.loggingConfiguration.upsert({
        where: { guildId_event: { guildId: input.guildId, event: config.event } },
        create: {
          guildId: input.guildId,
          event: config.event,
          enabled: config.enabled,
          channelIds: (config.channelIds ?? []) as Prisma.InputJsonValue,
          ignoreRoleIds: [] as Prisma.InputJsonValue,
          ignoreChannelIds: [] as Prisma.InputJsonValue,
        },
        update: { enabled: config.enabled, channelIds: (config.channelIds ?? []) as Prisma.InputJsonValue },
      });
    }
    await tx.auditRecord.create({
      data: {
        guildId: input.guildId,
        actorId: input.actorId ?? null,
        action: 'backup.restore',
        targetType: 'backup',
        targetId: backup.id,
        after: { restoredModules } as Prisma.InputJsonValue,
      },
    });
  });

  await prisma.backup.update({ where: { id: backup.id }, data: { restoredAt: new Date() } });
  logger.info('backup', 'Backup restored', { guildId: input.guildId, backupId: backup.id, modules: restoredModules.length });

  if ((snapshot.reactionRoles ?? []).length) {
    warnings.push('Reaction role panels require re-posting in Discord from the dashboard.');
  }
  return {
    restoredModules,
    restoredLogging: (snapshot.logging ?? []).length,
    restoredPanels: (snapshot.ticketPanels ?? []).length,
    warnings,
  };
}

export async function purgeExpiredBackups(guildId: string, retentionDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - Math.max(1, retentionDays) * 86_400_000);
  const result = await prisma.backup.deleteMany({ where: { guildId, createdAt: { lt: cutoff } } });
  return result.count;
}
