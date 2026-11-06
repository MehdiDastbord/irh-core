'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { api } from '@/lib/api';

export interface ResourceChannel {
  id: string;
  name: string;
  type: number;
  parentId: string | null;
}
export interface ResourceRole {
  id: string;
  name: string;
  color: number;
  position: number;
  managed: boolean;
}
export interface GuildInfo {
  id: string;
  discordId: string;
  name: string;
  icon: string | null;
  botPresent: boolean;
  accessLevel: string;
}

export interface GuildContextValue {
  guildId: string;
  guild: GuildInfo | null;
  channels: ResourceChannel[];
  roles: ResourceRole[];
  botPresent: boolean;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

const GuildContext = createContext<GuildContextValue | null>(null);

export function GuildProvider({ guildId, guild, children }: { guildId: string; guild: GuildInfo | null; children: React.ReactNode }) {
  const [channels, setChannels] = useState<ResourceChannel[]>([]);
  const [roles, setRoles] = useState<ResourceRole[]>([]);
  const [botPresent, setBotPresent] = useState(Boolean(guild?.botPresent));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<{ channels: ResourceChannel[]; roles: ResourceRole[]; botPresent: boolean; message?: string }>(`/guilds/${guildId}/resources`)
      .then((data) => {
        if (cancelled) return;
        setChannels(data.channels ?? []);
        setRoles(data.roles ?? []);
        setBotPresent(Boolean(data.botPresent));
        setError(data.botPresent ? null : data.message ?? 'Invite the bot to load channels and roles.');
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load Discord resources');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [guildId, nonce]);

  return (
    <GuildContext.Provider value={{ guildId, guild, channels, roles, botPresent, loading, error, reload: () => setNonce((value) => value + 1) }}>
      {children}
    </GuildContext.Provider>
  );
}

export function useGuild(): GuildContextValue {
  const context = useContext(GuildContext);
  if (!context) throw new Error('useGuild must be used inside GuildProvider');
  return context;
}

export function channelLabel(channel: ResourceChannel): string {
  const prefix = channel.type === 4 ? '▸ ' : channel.type === 2 ? '🔊 ' : channel.type === 15 ? '🧵 ' : channel.type === 5 ? '📢 ' : '#';
  return `${prefix}${channel.name}`;
}

export function roleLabel(role: ResourceRole): string {
  return `@${role.name}`;
}
