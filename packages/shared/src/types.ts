/**
 * Core shared types used by the bot, API and dashboard.
 */

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export type PunishmentAction =
  | 'none'
  | 'delete'
  | 'warn'
  | 'timeout'
  | 'kick'
  | 'ban'
  | 'softban'
  | 'remove_roles';

export interface EmbedSpec {
  title?: string;
  description?: string;
  color?: number;
  url?: string;
  author?: { name: string; iconURL?: string; url?: string };
  footer?: { text: string; iconURL?: string };
  thumbnail?: string;
  image?: string;
  timestamp?: boolean;
  fields?: { name: string; value: string; inline?: boolean }[];
}

export interface ModuleFieldOption {
  value: string;
  label: string;
}

export type FieldType =
  | 'boolean'
  | 'number'
  | 'text'
  | 'textarea'
  | 'select'
  | 'channel'
  | 'channels'
  | 'role'
  | 'roles'
  | 'color'
  | 'duration'
  | 'tags'
  | 'json';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  description?: string;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: ModuleFieldOption[];
  placeholder?: string;
  group?: string;
  advanced?: boolean;
  /** Channel types accepted by channel pickers (text, voice, category, forum, announcement) */
  channelTypes?: string[];
}

export interface ModuleDef {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: 'core' | 'moderation' | 'community' | 'engagement' | 'automation' | 'system';
  fields: FieldDef[];
}

export interface GuildSummary {
  id: string;
  name: string;
  icon: string | null;
  ownerId: string | null;
  memberCount: number;
  botPresent: boolean;
  accessLevel: 'owner' | 'admin' | 'manage_guild' | 'view';
}

export interface SessionUser {
  id: string;
  discordId: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
  email: string | null;
}

export interface LogEventDef {
  key: string;
  label: string;
  group: string;
  description?: string;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
}
