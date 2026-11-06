import { describe, expect, it } from 'vitest';
import {
  LOG_EVENTS,
  LOG_EVENT_GROUPS,
  MODULES,
  moduleDefaults,
  moduleById,
  parseDuration,
  formatDuration,
  renderTemplate,
  escapeMarkdown,
  snowflakeDate,
  chunk,
  truncate,
  validateModuleSettings,
} from '../src/index.js';
import { isSafeFeedUrl, normalizeFeedUrl, parseFeed } from '../src/feed.js';

describe('duration helpers', () => {
  it('parses suffixed durations', () => {
    expect(parseDuration('10m')).toBe(600_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('7d')).toBe(604_800_000);
    expect(parseDuration('1w')).toBe(604_800_000);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('45')).toBe(45);
  });

  it('rejects invalid input', () => {
    expect(parseDuration('soon')).toBeNull();
    expect(parseDuration('-5m')).toBeNull();
    expect(parseDuration(null)).toBeNull();
    expect(parseDuration(Number.NaN)).toBeNull();
  });

  it('formats durations compactly', () => {
    expect(formatDuration(5_400_000)).toBe('1h 30m');
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(null)).toBe('0s');
  });
});

describe('templates', () => {
  it('replaces known variables only', () => {
    expect(renderTemplate('Hi {user}, welcome to {server}! {unknown}', { user: '<@1>', server: 'IRH' })).toBe('Hi <@1>, welcome to IRH! {unknown}');
  });

  it('escapes markdown and mentions', () => {
    expect(escapeMarkdown('**hi** @everyone')).toBe('\\*\\*hi\\*\\* @\u200beveryone');
  });
});

describe('misc utilities', () => {
  it('derives a snowflake date', () => {
    const created = new Date('2024-06-01T00:00:00.000Z');
    const id = String((BigInt(created.getTime() - 1420070400000) << 22n) | 1n);
    const date = snowflakeDate(id);
    expect(date).toBeInstanceOf(Date);
    expect(date!.getTime()).toBe(created.getTime());
  });

  it('handles invalid snowflakes', () => {
    expect(snowflakeDate('nope')).toBeNull();
  });

  it('chunks and truncates', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('ab', 4)).toBe('ab');
  });
});

describe('module registry', () => {
  it('exposes every configurable module once', () => {
    const ids = MODULES.map((module) => module.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['general', 'moderation', 'automod', 'security', 'logging', 'welcome', 'verification', 'tickets', 'giveaways', 'automations', 'backups']) {
      expect(ids).toContain(id);
      expect(moduleById(id)).toBeTruthy();
    }
  });

  it('builds defaults from field defaults', () => {
    const defaults = moduleDefaults('automod') as Record<string, unknown>;
    expect(defaults).toBeTypeOf('object');
    for (const field of moduleById('automod')!.fields) {
      expect(defaults).toHaveProperty(field.key);
    }
  });

  it('validates settings and reports field errors', () => {
    expect(validateModuleSettings('automod', {}).ok).toBe(true);
    const invalid = validateModuleSettings('automod', { enabled: 'yes' });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(Object.keys(invalid.errors).length).toBeGreaterThan(0);
  });
});

describe('logging catalogue', () => {
  it('contains unique, grouped events', () => {
    expect(LOG_EVENTS.length).toBeGreaterThan(60);
    const keys = LOG_EVENTS.map((event) => event.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const event of LOG_EVENTS) {
      expect(event.label.length).toBeGreaterThan(0);
      expect(LOG_EVENT_GROUPS).toContain(event.group);
    }
    for (const required of ['message.delete', 'member.join', 'mod.ban', 'voice.join', 'channel.delete', 'role.delete', 'ticket.create', 'security.incident']) {
      expect(keys).toContain(required);
    }
  });
});

describe('feed parsing and SSRF protection', () => {
  it('parses an RSS document', () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Test</title><item><title>One</title><link>https://example.com/1</link><guid>1</guid><pubDate>Wed, 01 Jan 2025 00:00:00 GMT</pubDate></item></channel></rss>`;
    const parsed = parseFeed(xml);
    expect(parsed.title).toBe('Test');
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]!.title).toBe('One');
  });

  it('blocks private and loopback URLs', () => {
    expect(isSafeFeedUrl('http://localhost/feed')).toBe(false);
    expect(isSafeFeedUrl('http://127.0.0.1/feed')).toBe(false);
    expect(isSafeFeedUrl('http://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isSafeFeedUrl('http://192.168.1.2/feed')).toBe(false);
    expect(isSafeFeedUrl('https://example.com/feed.xml')).toBe(true);
  });

  it('normalizes common video feed URLs', () => {
    expect(normalizeFeedUrl('@MrBeast', 'youtube')).toContain('youtube.com/feeds/videos.xml');
    expect(normalizeFeedUrl('https://example.com/rss', 'rss')).toBe('https://example.com/rss');
    expect(normalizeFeedUrl('', 'rss')).toBeNull();
  });
});
