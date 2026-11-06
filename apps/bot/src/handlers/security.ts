/** Security audit-log listener: anti-nuke detection and incident reporting. */

import { AuditLogEvent, Events, type Client } from 'discord.js';
import { logger } from '@irh/db';
import { handleDestructiveAction, handleWebhookCreation } from '../modules/security.js';

const log = logger.child('security-handler');

const LABELS: Partial<Record<AuditLogEvent, string>> = {
  [AuditLogEvent.ChannelDelete]: 'Channel deletion',
  [AuditLogEvent.RoleDelete]: 'Role deletion',
  [AuditLogEvent.MemberBanAdd]: 'Mass ban',
  [AuditLogEvent.MemberKick]: 'Mass kick',
  [AuditLogEvent.WebhookCreate]: 'Webhook creation',
  [AuditLogEvent.WebhookUpdate]: 'Webhook update',
  [AuditLogEvent.MemberRoleUpdate]: 'Mass role change',
  [AuditLogEvent.GuildUpdate]: 'Server modification',
  [AuditLogEvent.EmojiDelete]: 'Emoji deletion',
};

const MASS_ACTIONS = new Set<AuditLogEvent>([AuditLogEvent.MemberBanAdd, AuditLogEvent.MemberKick, AuditLogEvent.MemberRoleUpdate]);

export function registerSecurityHandlers(client: Client): void {
  client.on(Events.GuildAuditLogEntryCreate, async (entry, guild) => {
    try {
      const label = LABELS[entry.action];
      if (!label) return;
      const actorId = entry.executor?.id ?? null;
      const targetId = (entry.target as { id?: string } | null)?.id ?? null;
      if (actorId && actorId === client.user?.id) return;

      if (entry.action === AuditLogEvent.WebhookCreate) {
        const target = entry.target as { name?: string; channelId?: string } | null;
        await handleWebhookCreation(guild, actorId, targetId ?? 'unknown', target?.name ?? 'unknown', target?.channelId ?? null);
        return;
      }

      if (!MASS_ACTIONS.has(entry.action) && entry.action !== AuditLogEvent.ChannelDelete && entry.action !== AuditLogEvent.RoleDelete) return;
      await handleDestructiveAction({ guild, type: entry.action, actorId, targetId, label });
    } catch (error) {
      log.warn('Audit log handling failed', { guildId: guild.id, error: String(error) });
    }
  });

  log.info('Security handlers registered');
}
