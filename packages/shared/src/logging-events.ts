/**
 * Logging event catalogue — every event the logging engine can route.
 * Grouped exactly like the dashboard navigation.
 */

import type { LogEventDef } from './types.js';

export const LOG_EVENT_GROUPS = [
  'Messages',
  'Members',
  'Punishments',
  'Roles & Channels',
  'Voice',
  'Server',
  'Integrations',
  'Community',
  'Security',
  'System',
] as const;

export type LogEventGroup = (typeof LOG_EVENT_GROUPS)[number];

export const LOG_EVENTS: LogEventDef[] = [
  // Messages
  { key: 'message.delete', label: 'Message Deleted', group: 'Messages' },
  { key: 'message.edit', label: 'Message Edited', group: 'Messages' },
  { key: 'message.bulkDelete', label: 'Messages Bulk Deleted', group: 'Messages' },
  { key: 'message.pin', label: 'Message Pinned', group: 'Messages' },
  { key: 'message.unpin', label: 'Message Unpinned', group: 'Messages' },
  { key: 'message.reactionAdd', label: 'Reaction Added', group: 'Messages' },
  { key: 'message.reactionRemove', label: 'Reaction Removed', group: 'Messages' },

  // Members
  { key: 'member.join', label: 'Member Joined', group: 'Members' },
  { key: 'member.leave', label: 'Member Left', group: 'Members' },
  { key: 'member.update', label: 'Member Updated (nickname/roles)', group: 'Members' },
  { key: 'member.rolesUpdate', label: 'Member Roles Changed', group: 'Members' },
  { key: 'member.nickname', label: 'Nickname Changed', group: 'Members' },
  { key: 'member.avatar', label: 'Member Avatar Changed', group: 'Members' },
  { key: 'member.timeout', label: 'Member Timed Out', group: 'Members' },
  { key: 'member.timeoutRemove', label: 'Timeout Removed', group: 'Members' },
  { key: 'member.boost', label: 'Server Boosted', group: 'Members' },
  { key: 'member.unboost', label: 'Boost Removed', group: 'Members' },

  // Punishments
  { key: 'mod.ban', label: 'Member Banned', group: 'Punishments' },
  { key: 'mod.unban', label: 'Member Unbanned', group: 'Punishments' },
  { key: 'mod.kick', label: 'Member Kicked', group: 'Punishments' },
  { key: 'mod.warn', label: 'Member Warned', group: 'Punishments' },
  { key: 'mod.warnRevoked', label: 'Warning Revoked', group: 'Punishments' },
  { key: 'mod.timeout', label: 'Timeout Applied', group: 'Punishments' },
  { key: 'mod.purge', label: 'Messages Purged', group: 'Punishments' },
  { key: 'mod.caseUpdate', label: 'Moderation Case Updated', group: 'Punishments' },
  { key: 'mod.appeal', label: 'Appeal Submitted', group: 'Punishments' },

  // Roles & channels
  { key: 'role.create', label: 'Role Created', group: 'Roles & Channels' },
  { key: 'role.delete', label: 'Role Deleted', group: 'Roles & Channels' },
  { key: 'role.update', label: 'Role Updated', group: 'Roles & Channels' },
  { key: 'channel.create', label: 'Channel Created', group: 'Roles & Channels' },
  { key: 'channel.delete', label: 'Channel Deleted', group: 'Roles & Channels' },
  { key: 'channel.update', label: 'Channel Updated', group: 'Roles & Channels' },
  { key: 'permission.update', label: 'Permissions Changed', group: 'Roles & Channels' },
  { key: 'thread.create', label: 'Thread Created', group: 'Roles & Channels' },
  { key: 'thread.delete', label: 'Thread Deleted', group: 'Roles & Channels' },

  // Voice
  { key: 'voice.join', label: 'Voice Joined', group: 'Voice' },
  { key: 'voice.leave', label: 'Voice Left', group: 'Voice' },
  { key: 'voice.move', label: 'Voice Moved', group: 'Voice' },
  { key: 'voice.mute', label: 'Server Mute/Deafen', group: 'Voice' },

  // Server
  { key: 'server.update', label: 'Server Updated', group: 'Server' },
  { key: 'emoji.create', label: 'Emoji Added', group: 'Server' },
  { key: 'emoji.delete', label: 'Emoji Removed', group: 'Server' },
  { key: 'emoji.update', label: 'Emoji Renamed', group: 'Server' },
  { key: 'sticker.create', label: 'Sticker Added', group: 'Server' },
  { key: 'sticker.delete', label: 'Sticker Removed', group: 'Server' },
  { key: 'sticker.update', label: 'Sticker Updated', group: 'Server' },
  { key: 'invite.create', label: 'Invite Created', group: 'Server' },
  { key: 'invite.delete', label: 'Invite Deleted', group: 'Server' },
  { key: 'webhook.create', label: 'Webhook Created', group: 'Server' },
  { key: 'webhook.update', label: 'Webhook Updated', group: 'Server' },
  { key: 'webhook.delete', label: 'Webhook Deleted', group: 'Server' },

  // Integrations
  { key: 'integration.create', label: 'Integration Added', group: 'Integrations' },
  { key: 'integration.update', label: 'Integration Updated', group: 'Integrations' },
  { key: 'integration.delete', label: 'Integration Removed', group: 'Integrations' },
  { key: 'automod.action', label: 'AutoMod Rule Triggered (Discord)', group: 'Integrations' },
  { key: 'automod.config', label: 'AutoMod Config Changed', group: 'Integrations' },

  // Community
  { key: 'ticket.create', label: 'Ticket Opened', group: 'Community' },
  { key: 'ticket.close', label: 'Ticket Closed', group: 'Community' },
  { key: 'ticket.claim', label: 'Ticket Claimed', group: 'Community' },
  { key: 'ticket.feedback', label: 'Ticket Feedback', group: 'Community' },
  { key: 'giveaway.create', label: 'Giveaway Started', group: 'Community' },
  { key: 'giveaway.end', label: 'Giveaway Ended', group: 'Community' },
  { key: 'giveaway.reroll', label: 'Giveaway Rerolled', group: 'Community' },
  { key: 'level.up', label: 'Level Up', group: 'Community' },
  { key: 'invite.track', label: 'Invite Tracked', group: 'Community' },
  { key: 'announcement.sent', label: 'Announcement Sent', group: 'Community' },
  { key: 'feed.posted', label: 'Feed Posted', group: 'Community' },

  // Security
  { key: 'security.incident', label: 'Security Incident', group: 'Security' },
  { key: 'security.raid', label: 'Raid Detected', group: 'Security' },
  { key: 'security.nuke', label: 'Nuke Attempt Detected', group: 'Security' },
  { key: 'security.honeypot', label: 'Honeypot Triggered', group: 'Security' },
  { key: 'security.lockdown', label: 'Lockdown State Changed', group: 'Security' },
  { key: 'security.alt', label: 'Suspicious Account Detected', group: 'Security' },
  { key: 'security.trusted', label: 'Trusted User Changed', group: 'Security' },

  // System
  { key: 'system.error', label: 'Module Error', group: 'System' },
  { key: 'system.backup', label: 'Backup Created', group: 'System' },
  { key: 'system.restore', label: 'Backup Restored', group: 'System' },
  { key: 'system.botStart', label: 'Bot Started', group: 'System' },
  { key: 'system.jobFail', label: 'Scheduled Job Failed', group: 'System' },
];

export const LOG_EVENT_KEYS = LOG_EVENTS.map((event) => event.key);

/** Events enabled by default when a guild first configures logging. */
export const DEFAULT_ENABLED_LOG_EVENTS = [
  'message.delete',
  'message.edit',
  'message.bulkDelete',
  'member.join',
  'member.leave',
  'member.rolesUpdate',
  'mod.ban',
  'mod.unban',
  'mod.kick',
  'mod.warn',
  'mod.timeout',
  'mod.purge',
  'role.create',
  'role.delete',
  'role.update',
  'channel.create',
  'channel.delete',
  'channel.update',
  'voice.join',
  'voice.leave',
  'server.update',
  'emoji.create',
  'emoji.delete',
  'ticket.create',
  'ticket.close',
  'security.incident',
] as const;

export function logEventDef(key: string): LogEventDef | undefined {
  return LOG_EVENTS.find((event) => event.key === key);
}
