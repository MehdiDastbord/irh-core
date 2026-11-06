/**
 * Small, dependency-free helpers shared by the API, bot and dashboard.
 */

/** Parse `10m`, `2h`, `7d`, `1w`, `30s` or a plain number of milliseconds. */
export function parseDuration(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? Math.floor(input) : null;
  const trimmed = input.trim().toLowerCase();
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  const match = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/.exec(
    trimmed,
  );
  if (!match) return null;
  const value = Number.parseFloat(match[1] as string);
  const unit = match[2] as string;
  const factor =
    unit.startsWith('s') ? 1_000
    : unit.startsWith('m') ? 60_000
    : unit.startsWith('h') ? 3_600_000
    : unit.startsWith('d') ? 86_400_000
    : 604_800_000;
  return Math.floor(value * factor);
}

/** Human readable duration, e.g. 5400000 -> "1h 30m". */
export function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '0s';
  const units: [number, string][] = [
    [604_800_000, 'w'],
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [60_000, 'm'],
    [1_000, 's'],
  ];
  let remaining = Math.floor(ms);
  const parts: string[] = [];
  for (const [size, label] of units) {
    if (remaining >= size) {
      parts.push(`${Math.floor(remaining / size)}${label}`);
      remaining %= size;
    }
  }
  return parts.slice(0, 2).join(' ') || '0s';
}

/** Discord snowflake -> creation date. */
export function snowflakeDate(id: string): Date | null {
  try {
    const timestamp = Number((BigInt(id) >> 22n) + 1420070400000n);
    if (!Number.isFinite(timestamp)) return null;
    return new Date(timestamp);
  } catch {
    return null;
  }
}

export function truncate(value: string, max = 1024): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** Escape user-provided text for Markdown embeds (prevents @everyone / formatting injection). */
export function escapeMarkdown(value: string): string {
  return value.replace(/[*_`~|\\]/g, (m) => `\\${m}`).replace(/@(everyone|here)/gi, '@\u200b$1');
}

export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk size must be positive');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

const TEMPLATE_VARS = [
  'user',
  'userTag',
  'userName',
  'userId',
  'server',
  'memberCount',
  'boostCount',
  'createdAt',
  'joinedAt',
  'inviter',
  'invites',
  'level',
  'xp',
  'rank',
] as const;

export type TemplateVariables = Partial<Record<(typeof TEMPLATE_VARS)[number], string | number | null | undefined>>;

/** Replace `{variable}` placeholders, leaving unknown variables untouched. */
export function renderTemplate(template: string, vars: TemplateVariables): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (!(TEMPLATE_VARS as readonly string[]).includes(key)) return match;
    const value = vars[key as (typeof TEMPLATE_VARS)[number]];
    return value === null || value === undefined ? match : String(value);
  });
}

export function templateVariables(): readonly string[] {
  return TEMPLATE_VARS;
}

export function randomCode(length = 6): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

export function pickRandom<T>(items: T[]): T | undefined {
  return items.length ? items[Math.floor(Math.random() * items.length)] : undefined;
}

export function dateKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** XP needed to reach a level (consistent curve, quadratic growth). */
export function xpForLevel(level: number): number {
  if (level <= 0) return 0;
  return Math.floor(100 * level ** 1.6);
}

export function levelFromXp(xp: number): number {
  let level = 0;
  while (level < 500 && xp >= xpForLevel(level + 1)) level += 1;
  return level;
}

export function levelProgress(xp: number): { level: number; current: number; needed: number; percent: number } {
  const level = levelFromXp(xp);
  const base = xpForLevel(level);
  const needed = Math.max(1, xpForLevel(level + 1) - base);
  const current = Math.max(0, xp - base);
  return { level, current, needed, percent: Math.min(100, Math.round((current / needed) * 100)) };
}

export function discordAvatarUrl(userId: string, avatarHash: string | null | undefined, size = 128): string {
  if (!avatarHash) {
    const index = Number((BigInt(userId) >> 22n) % 6n);
    return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
  }
  const ext = avatarHash.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${ext}?size=${size}`;
}

export function discordGuildIconUrl(guildId: string, icon: string | null | undefined, size = 128): string | null {
  if (!icon) return null;
  const ext = icon.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/icons/${guildId}/${icon}.${ext}?size=${size}`;
}

export function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with jitter, capped at `max`. */
export function backoffDelay(attempt: number, baseMs = 500, maxMs = 60_000): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

export function isSnowflake(value: unknown): value is string {
  return typeof value === 'string' && /^\d{15,25}$/.test(value);
}
