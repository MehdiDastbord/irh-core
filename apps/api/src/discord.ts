/** Minimal Discord REST client used server-side (OAuth + bot actions). */

import { env } from './env.js';
import { logger } from '@irh/db';

const API = 'https://discord.com/api/v10';

export class DiscordApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'DiscordApiError';
  }
}

async function request<T>(path: string, init: RequestInit & { token?: string; authScheme?: 'Bot' | 'Bearer'; attempts?: number } = {}): Promise<T> {
  const { token, authScheme = 'Bot', attempts = 0, ...rest } = init;
  const response = await fetch(`${API}${path}`, {
    ...rest,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `${authScheme} ${token}` } : {}),
      ...(rest.headers ?? {}),
    },
  });

  if (response.status === 429 && attempts < 3) {
    let retryAfter = 1;
    try {
      const payload = (await response.json()) as { retry_after?: number };
      retryAfter = Math.min(10, Math.max(0.2, payload.retry_after ?? 1));
    } catch {
      /* default */
    }
    logger.warn('discord', 'Rate limited, retrying', { path, retryAfter });
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
    return request<T>(path, { ...init, attempts: attempts + 1 });
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }

  if (!response.ok) {
    throw new DiscordApiError(`Discord API ${path} failed (${response.status})`, response.status, body);
  }
  return body as T;
}

export interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
  email?: string | null;
}

export interface DiscordGuild {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: string;
}

export interface DiscordChannel {
  id: string;
  name: string;
  type: number;
  parent_id: string | null;
  position: number;
}

export interface DiscordRole {
  id: string;
  name: string;
  color: number;
  position: number;
  managed: boolean;
}

export interface DiscordMember {
  user: DiscordUser;
  roles: string[];
  joined_at: string;
  communication_disabled_until?: string | null;
}

export interface DiscordGuildSummary {
  id: string;
  name: string;
  icon: string | null;
  owner_id: string;
  member_count?: number;
}

export function botToken(): string {
  if (!env.discord.botToken) throw new DiscordApiError('DISCORD_BOT_TOKEN is not configured', 503);
  return env.discord.botToken;
}

export const discordApi = {
  exchangeCode(code: string) {
    const body = new URLSearchParams({
      client_id: env.discord.clientId,
      client_secret: env.discord.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: env.discord.redirectUri,
    });
    return request<{ access_token: string; refresh_token: string; expires_in: number; scope: string; token_type: string }>(
      '/oauth2/token',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      },
    );
  },

  refreshToken(refreshToken: string) {
    const body = new URLSearchParams({
      client_id: env.discord.clientId,
      client_secret: env.discord.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    return request<{ access_token: string; refresh_token: string; expires_in: number; scope: string }>('/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  },

  currentUser(accessToken: string) {
    return request<DiscordUser>('/users/@me', { token: accessToken, authScheme: 'Bearer' });
  },

  userGuilds(accessToken: string) {
    return request<DiscordGuild[]>('/users/@me/guilds', { token: accessToken, authScheme: 'Bearer' });
  },

  guild(guildId: string) {
    return request<DiscordGuildSummary>(`/guilds/${guildId}`, { token: botToken() });
  },

  guildChannels(guildId: string) {
    return request<DiscordChannel[]>(`/guilds/${guildId}/channels`, { token: botToken() });
  },

  guildRoles(guildId: string) {
    return request<DiscordRole[]>(`/guilds/${guildId}/roles`, { token: botToken() });
  },

  guildMember(guildId: string, userId: string) {
    return request<DiscordMember>(`/guilds/${guildId}/members/${userId}`, { token: botToken() });
  },

  guildEmojis(guildId: string) {
    return request<{ id: string; name: string; animated: boolean }[]>(`/guilds/${guildId}/emojis`, { token: botToken() });
  },

  guildStickers(guildId: string) {
    return request<{ id: string; name: string; format_type: number }[]>(`/guilds/${guildId}/stickers`, { token: botToken() });
  },

  createMessage(channelId: string, body: unknown) {
    return request<{ id: string; channel_id: string }>(`/channels/${channelId}/messages`, {
      method: 'POST',
      token: botToken(),
      body: JSON.stringify(body),
    });
  },

  editMessage(channelId: string, messageId: string, body: unknown) {
    return request<{ id: string }>(`/channels/${channelId}/messages/${messageId}`, {
      method: 'PATCH',
      token: botToken(),
      body: JSON.stringify(body),
    });
  },

  deleteMessage(channelId: string, messageId: string) {
    return request<void>(`/channels/${channelId}/messages/${messageId}`, { method: 'DELETE', token: botToken() });
  },

  ban(guildId: string, userId: string, reason?: string, deleteMessageSeconds = 0) {
    return request<void>(`/guilds/${guildId}/bans/${userId}`, {
      method: 'PUT',
      token: botToken(),
      body: JSON.stringify({ delete_message_seconds: deleteMessageSeconds, ...(reason ? { reason } : {}) }),
    });
  },

  unban(guildId: string, userId: string) {
    return request<void>(`/guilds/${guildId}/bans/${userId}`, { method: 'DELETE', token: botToken() });
  },

  kick(guildId: string, userId: string) {
    return request<void>(`/guilds/${guildId}/members/${userId}`, { method: 'DELETE', token: botToken() });
  },

  timeout(guildId: string, userId: string, durationMs: number) {
    return request<void>(`/guilds/${guildId}/members/${userId}`, {
      method: 'PATCH',
      token: botToken(),
      body: JSON.stringify({ communication_disabled_until: durationMs > 0 ? new Date(Date.now() + durationMs).toISOString() : null }),
    });
  },

  addRole(guildId: string, userId: string, roleId: string) {
    return request<void>(`/guilds/${guildId}/members/${userId}/roles/${roleId}`, { method: 'PUT', token: botToken() });
  },

  removeRole(guildId: string, userId: string, roleId: string) {
    return request<void>(`/guilds/${guildId}/members/${userId}/roles/${roleId}`, { method: 'DELETE', token: botToken() });
  },

  createInvite(channelId: string, body: { max_age?: number; max_uses?: number; unique?: boolean; reason?: string } = {}) {
    return request<{ code: string }>(`/channels/${channelId}/invites`, {
      method: 'POST',
      token: botToken(),
      body: JSON.stringify({ max_age: 0, max_uses: 0, unique: true, ...body }),
    });
  },

  /** Direct REST call used by the dashboard for arbitrary channel edits (lockdown etc.). */
  channel(guildId: string, channelId: string, body: unknown, method: 'PATCH' | 'DELETE' = 'PATCH') {
    return request<unknown>(`/channels/${channelId}`, {
      method,
      token: botToken(),
      body: method === 'PATCH' ? JSON.stringify(body) : undefined,
    });
  },
};

export function inviteUrl(): string | null {
  if (!env.discord.clientId) return null;
  const permissions = '1101659158930';
  return `https://discord.com/oauth2/authorize?client_id=${env.discord.clientId}&permissions=${permissions}&scope=bot%20applications.commands`;
}
