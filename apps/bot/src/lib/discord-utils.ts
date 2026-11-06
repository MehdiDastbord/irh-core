/** Discord helpers: safe sends, permission checks, hierarchy. */

import {
  type Channel,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type Message,
  type TextChannel,
  type VoiceChannel,
  type NewsChannel,
  PermissionFlagsBits,
  type Role,
} from 'discord.js';
import { canModerate, denialMessage } from '@irh/shared';
import { logger } from '@irh/db';

const scope = logger.child('discord');

export type SendableChannel = TextChannel | NewsChannel;

export function isSendable(channel: Channel | GuildBasedChannel | null | undefined): channel is SendableChannel {
  return Boolean(channel && channel.isTextBased() && 'send' in channel && !channel.isDMBased());
}

export async function safeSend(channel: Channel | null | undefined, payload: Parameters<SendableChannel['send']>[0]): Promise<Message | null> {
  if (!isSendable(channel)) return null;
  try {
    return await channel.send(payload);
  } catch (error) {
    scope.warn('Failed to send message', { channelId: channel.id, error: String(error) });
    return null;
  }
}

export async function safeDm(member: GuildMember, payload: Parameters<SendableChannel['send']>[0]): Promise<boolean> {
  try {
    await member.send(payload);
    return true;
  } catch {
    return false;
  }
}

export function highestRolePosition(member: GuildMember): number {
  if (member.id === member.guild.ownerId) return Number.MAX_SAFE_INTEGER;
  return member.roles.highest.position;
}

export function canActOn(actor: GuildMember, target: GuildMember, requiredPermission?: bigint): { allowed: boolean; message?: string } {
  const actorHasPermission = requiredPermission ? actor.permissions.has(requiredPermission) : true;
  const result = canModerate({
    guild: { ownerId: actor.guild.ownerId, botPosition: actor.guild.members.me?.roles.highest.position ?? 0 },
    actor: { id: actor.id, highestRolePosition: highestRolePosition(actor), isOwner: actor.id === actor.guild.ownerId },
    target: { id: target.id, highestRolePosition: highestRolePosition(target), isOwner: target.id === target.guild.ownerId },
    actorHasPermission,
  });
  return { allowed: result.allowed, message: result.allowed ? undefined : denialMessage(result.reason) };
}

export function botCanManage(member: GuildMember): boolean {
  const me = member.guild.members.me;
  if (!me) return false;
  if (member.id === member.guild.ownerId) return false;
  return me.roles.highest.position > member.roles.highest.position;
}

export function canBotEditChannel(guild: Guild, channel: GuildBasedChannel): boolean {
  const me = guild.members.me;
  return Boolean(me?.permissionsIn(channel).has(PermissionFlagsBits.ManageChannels));
}

export async function resolveMember(guild: Guild, id: string): Promise<GuildMember | null> {
  const cached = guild.members.cache.get(id);
  if (cached) return cached;
  return guild.members.fetch(id).catch(() => null);
}

export async function resolveRole(guild: Guild, id: string): Promise<Role | null> {
  const cached = guild.roles.cache.get(id);
  if (cached) return cached;
  return guild.roles.fetch(id).catch(() => null);
}

export function isVoiceChannel(channel: Channel | null | undefined): channel is VoiceChannel {
  return Boolean(channel && channel.isVoiceBased());
}

/** Format a user/member for logs without ever fabricating missing data. */
export function userLabel(id: string | null | undefined, tag?: string | null): string {
  if (!id) return 'Unknown';
  return tag ? `${tag} (${id})` : id;
}

export function relativeTimestamp(date: Date | number | null | undefined): string {
  if (!date) return 'unknown';
  const time = typeof date === 'number' ? date : date.getTime();
  return `<t:${Math.floor(time / 1000)}:R>`;
}

export function fullTimestamp(date: Date | number | null | undefined): string {
  if (!date) return 'unknown';
  const time = typeof date === 'number' ? date : date.getTime();
  return `<t:${Math.floor(time / 1000)}:F>`;
}

export function truncate(value: string, max = 1024): string {
  if (!value) return '';
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
