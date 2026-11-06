/** Gateway event logging with separate audit-log correlation. */

import {
  AuditLogEvent,
  Events,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type Message,
  type PartialMessage,
} from 'discord.js';
import { logger } from '@irh/db';
import { emitLog, correlateExecutor } from '../lib/logging.js';
import { truncate } from '../lib/discord-utils.js';

const log = logger.child('logging-handler');

function canReadAudit(guild: Guild): boolean {
  return Boolean(guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog));
}

export function registerLoggingHandlers(client: Client): void {
  client.on(Events.MessageDelete, async (message: Message | PartialMessage) => {
    if (!message.guild) return;
    await emitLog({
      guild: message.guild,
      event: 'message.delete',
      summary: `Message by ${message.author?.tag ?? 'unknown'} deleted in <#${message.channelId}>`,
      targetId: message.author?.id ?? null,
      channelId: message.channelId,
      messageId: message.id,
      fields: message.content ? [{ name: 'Content', value: truncate(message.content, 900) }] : [],
    }).catch((error) => log.warn('log failed', { error: String(error) }));
  });

  client.on(Events.MessageUpdate, async (before, after) => {
    if (!after.guild || before.content === after.content) return;
    await emitLog({
      guild: after.guild,
      event: 'message.edit',
      summary: `Message by ${after.author?.tag ?? 'unknown'} edited in <#${after.channelId}>`,
      targetId: after.author?.id ?? null,
      channelId: after.channelId,
      messageId: after.id,
      fields: [
        { name: 'Before', value: truncate(before.content ?? '*(unknown)*', 500) },
        { name: 'After', value: truncate(after.content ?? '*(unknown)*', 500) },
      ],
    }).catch(() => undefined);
  });

  client.on(Events.MessageBulkDelete, async (messages, channel) => {
    if (!('guild' in channel) || !channel.guild) return;
    await emitLog({
      guild: channel.guild,
      event: 'message.bulkDelete',
      summary: `${messages.size} messages bulk deleted in <#${channel.id}>`,
      channelId: channel.id,
      executorId: canReadAudit(channel.guild) ? await correlateExecutor(channel.guild, AuditLogEvent.MessageBulkDelete, channel.id) : null,
    }).catch(() => undefined);
  });

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    if (reaction.partial) await reaction.fetch().catch(() => undefined);
    const guild = reaction.message.guild;
    if (!guild || user.bot) return;
    await emitLog({
      guild,
      event: 'message.reactionAdd',
      summary: `${user.tag} reacted with ${reaction.emoji.toString()} in <#${reaction.message.channelId}>`,
      executorId: user.id,
      channelId: reaction.message.channelId,
      messageId: reaction.message.id,
    }).catch(() => undefined);
  });

  client.on(Events.MessageReactionRemove, async (reaction, user) => {
    if (reaction.partial) await reaction.fetch().catch(() => undefined);
    const guild = reaction.message.guild;
    if (!guild || user.bot) return;
    await emitLog({
      guild,
      event: 'message.reactionRemove',
      summary: `${user.tag} removed ${reaction.emoji.toString()} in <#${reaction.message.channelId}>`,
      executorId: user.id,
      channelId: reaction.message.channelId,
      messageId: reaction.message.id,
    }).catch(() => undefined);
  });

  client.on(Events.GuildBanAdd, async (ban) => {
    await emitLog({
      guild: ban.guild,
      event: 'mod.ban',
      summary: `${ban.user.tag} was banned`,
      executorId: canReadAudit(ban.guild) ? await correlateExecutor(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id) : null,
      targetId: ban.user.id,
      fields: ban.reason ? [{ name: 'Reason', value: truncate(ban.reason, 500) }] : [],
    }).catch(() => undefined);
  });

  client.on(Events.GuildBanRemove, async (ban) => {
    await emitLog({
      guild: ban.guild,
      event: 'mod.unban',
      summary: `${ban.user.tag} was unbanned`,
      executorId: canReadAudit(ban.guild) ? await correlateExecutor(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id) : null,
      targetId: ban.user.id,
    }).catch(() => undefined);
  });

  client.on(Events.GuildRoleCreate, async (role) => {
    await emitLog({
      guild: role.guild,
      event: 'role.create',
      summary: `Role **${role.name}** created`,
      targetId: role.id,
      executorId: canReadAudit(role.guild) ? await correlateExecutor(role.guild, AuditLogEvent.RoleCreate, role.id) : null,
    }).catch(() => undefined);
  });

  client.on(Events.GuildRoleDelete, async (role) => {
    await emitLog({
      guild: role.guild,
      event: 'role.delete',
      summary: `Role **${role.name}** (\`${role.id}\`) deleted`,
      targetId: role.id,
      executorId: canReadAudit(role.guild) ? await correlateExecutor(role.guild, AuditLogEvent.RoleDelete, role.id) : null,
    }).catch(() => undefined);
  });

  client.on(Events.GuildRoleUpdate, async (before, after) => {
    const changes: string[] = [];
    if (before.name !== after.name) changes.push(`name: **${before.name}** → **${after.name}**`);
    if (before.color !== after.color) changes.push(`color: ${before.hexColor} → ${after.hexColor}`);
    if (before.permissions.bitfield !== after.permissions.bitfield) changes.push('permissions changed');
    if (!changes.length) return;
    await emitLog({
      guild: after.guild,
      event: 'role.update',
      summary: `Role **${after.name}** updated`,
      targetId: after.id,
      executorId: canReadAudit(after.guild) ? await correlateExecutor(after.guild, AuditLogEvent.RoleUpdate, after.id) : null,
      fields: [{ name: 'Changes', value: changes.join('\n') }],
    }).catch(() => undefined);
  });

  client.on(Events.ChannelCreate, async (channel) => {
    if (!('guild' in channel) || !channel.guild) return;
    await emitLog({
      guild: channel.guild,
      event: 'channel.create',
      summary: `${channel.type} channel **${channel.name}** created`,
      targetId: channel.id,
      channelId: channel.id,
      executorId: canReadAudit(channel.guild) ? await correlateExecutor(channel.guild, AuditLogEvent.ChannelCreate, channel.id) : null,
    }).catch(() => undefined);
  });

  client.on(Events.ChannelDelete, async (channel) => {
    if (!('guild' in channel) || !channel.guild) return;
    await emitLog({
      guild: channel.guild,
      event: 'channel.delete',
      summary: `Channel **${channel.name}** (\`${channel.id}\`) deleted`,
      targetId: channel.id,
      channelId: channel.id,
      executorId: canReadAudit(channel.guild) ? await correlateExecutor(channel.guild, AuditLogEvent.ChannelDelete, channel.id) : null,
    }).catch(() => undefined);
  });

  client.on(Events.ChannelUpdate, async (before, after) => {
    if (!('guild' in after) || !after.guild || !('guild' in before) || !before.guild) return;
    const changes: string[] = [];
    if (before.name !== after.name) changes.push(`name: **${before.name}** → **${after.name}**`);
    if ('topic' in before && 'topic' in after && before.topic !== after.topic) changes.push('topic changed');
    if ('nsfw' in before && 'nsfw' in after && before.nsfw !== after.nsfw) changes.push(`NSFW: ${before.nsfw} → ${after.nsfw}`);
    if ('rateLimitPerUser' in before && 'rateLimitPerUser' in after && before.rateLimitPerUser !== after.rateLimitPerUser) {
      changes.push(`slowmode: ${before.rateLimitPerUser}s → ${after.rateLimitPerUser}s`);
    }
    if (!changes.length) return;
    await emitLog({
      guild: after.guild,
      event: 'channel.update',
      summary: `Channel <#${after.id}> updated`,
      targetId: after.id,
      channelId: after.id,
      executorId: canReadAudit(after.guild) ? await correlateExecutor(after.guild, AuditLogEvent.ChannelUpdate, after.id) : null,
      fields: [{ name: 'Changes', value: changes.join('\n') }],
    }).catch(() => undefined);
  });

  client.on(Events.GuildEmojiCreate, async (emoji) => {
    await emitLog({
      guild: emoji.guild,
      event: 'emoji.create',
      summary: `Emoji ${emoji} \`${emoji.name}\` added`,
      targetId: emoji.id,
      executorId: canReadAudit(emoji.guild) ? await correlateExecutor(emoji.guild, AuditLogEvent.EmojiCreate, emoji.id) : null,
    }).catch(() => undefined);
  });

  client.on(Events.GuildEmojiDelete, async (emoji) => {
    await emitLog({
      guild: emoji.guild,
      event: 'emoji.delete',
      summary: `Emoji \`${emoji.name}\` deleted`,
      targetId: emoji.id,
      executorId: canReadAudit(emoji.guild) ? await correlateExecutor(emoji.guild, AuditLogEvent.EmojiDelete, emoji.id) : null,
    }).catch(() => undefined);
  });

  client.on(Events.GuildEmojiUpdate, async (before, after) => {
    await emitLog({
      guild: after.guild,
      event: 'emoji.update',
      summary: `Emoji renamed: \`${before.name}\` → \`${after.name}\``,
      targetId: after.id,
      executorId: canReadAudit(after.guild) ? await correlateExecutor(after.guild, AuditLogEvent.EmojiUpdate, after.id) : null,
    }).catch(() => undefined);
  });

  client.on(Events.GuildStickerCreate, async (sticker) => {
    const guild = sticker.guild;
    if (!guild) return;
    await emitLog({ guild, event: 'sticker.create', summary: `Sticker \`${sticker.name}\` added`, targetId: sticker.id }).catch(() => undefined);
  });

  client.on(Events.GuildStickerDelete, async (sticker) => {
    const guild = sticker.guild;
    if (!guild) return;
    await emitLog({ guild, event: 'sticker.delete', summary: `Sticker \`${sticker.name}\` deleted`, targetId: sticker.id }).catch(() => undefined);
  });

  client.on(Events.GuildStickerUpdate, async (before, after) => {
    if (before.name === after.name) return;
    const guild = after.guild;
    if (!guild) return;
    await emitLog({ guild, event: 'sticker.update', summary: `Sticker renamed: \`${before.name}\` → \`${after.name}\``, targetId: after.id }).catch(() => undefined);
  });

  client.on(Events.InviteCreate, async (invite) => {
    if (!invite.guild) return;
    await emitLog({
      guild: invite.guild as Guild,
      event: 'invite.create',
      summary: `Invite \`${invite.code}\` created${invite.channel ? ` in <#${invite.channel.id}>` : ''}`,
      executorId: invite.inviter?.id ?? null,
      channelId: invite.channel?.id ?? null,
      fields: [
        { name: 'Uses', value: String(invite.uses ?? 0), inline: true },
        { name: 'Max uses', value: String(invite.maxUses ?? 0), inline: true },
      ],
    }).catch(() => undefined);
  });

  client.on(Events.InviteDelete, async (invite) => {
    if (!invite.guild) return;
    await emitLog({
      guild: invite.guild as Guild,
      event: 'invite.delete',
      summary: `Invite \`${invite.code}\` deleted`,
      channelId: invite.channel?.id ?? null,
    }).catch(() => undefined);
  });

  client.on(Events.GuildUpdate, async (before, after) => {
    const changes: string[] = [];
    if (before.name !== after.name) changes.push(`name: **${before.name}** → **${after.name}**`);
    if (before.icon !== after.icon) changes.push('icon changed');
    if (!changes.length) return;
    await emitLog({
      guild: after,
      event: 'server.update',
      summary: 'Server settings updated',
      executorId: canReadAudit(after) ? await correlateExecutor(after, AuditLogEvent.GuildUpdate, after.id) : null,
      fields: [{ name: 'Changes', value: changes.join('\n') }],
    }).catch(() => undefined);
  });

  client.on(Events.AutoModerationActionExecution, async (execution) => {
    await emitLog({
      guild: execution.guild,
      event: 'automod.action',
      summary: `Discord AutoMod **${execution.ruleTriggerType}** triggered for <@${execution.userId}> in <#${execution.channelId ?? ''}>`,
      targetId: execution.userId,
      channelId: execution.channelId ?? null,
      fields: [
        { name: 'Rule', value: execution.ruleId, inline: true },
        { name: 'Action', value: String(execution.action.type), inline: true },
        ...(execution.matchedContent ? [{ name: 'Matched', value: truncate(execution.matchedContent, 500) }] : []),
      ],
    }).catch(() => undefined);
  });

  client.on(Events.ThreadCreate, async (thread) => {
    await emitLog({ guild: thread.guild, event: 'thread.create', summary: `Thread **${thread.name}** created`, targetId: thread.id, channelId: thread.id }).catch(() => undefined);
  });

  client.on(Events.ThreadDelete, async (thread) => {
    await emitLog({ guild: thread.guild, event: 'thread.delete', summary: `Thread **${thread.name}** deleted`, targetId: thread.id }).catch(() => undefined);
  });

  client.on(Events.WebhooksUpdate, async (channel) => {
    if (!('guild' in channel) || !channel.guild) return;
    await emitLog({
      guild: channel.guild,
      event: 'webhook.update',
      summary: `Webhooks updated in <#${channel.id}>`,
      channelId: channel.id,
      executorId: canReadAudit(channel.guild) ? await correlateExecutor(channel.guild, AuditLogEvent.WebhookUpdate, channel.id) : null,
    }).catch(() => undefined);
  });

  client.on(Events.GuildIntegrationsUpdate, async (guild) => {
    await emitLog({ guild, event: 'integration.update', summary: 'Server integrations updated' }).catch(() => undefined);
  });

  client.on(Events.GuildScheduledEventCreate, async (event) => {
    if (!event.guild) return;
    await emitLog({ guild: event.guild, event: 'server.update', summary: `Scheduled event **${event.name}** created`, targetId: event.id, executorId: event.creatorId ?? null }).catch(() => undefined);
  });

  client.on(Events.GuildScheduledEventDelete, async (event) => {
    if (!event.guild) return;
    await emitLog({ guild: event.guild, event: 'server.update', summary: `Scheduled event **${event.name}** deleted`, targetId: event.id }).catch(() => undefined);
  });

  log.info('Logging handlers registered');
}
