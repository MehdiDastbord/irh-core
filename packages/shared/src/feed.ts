/** Feed parsing shared by the API (previews) and the bot (polling). */

import { XMLParser } from 'fast-xml-parser';

export interface FeedEntry {
  id: string;
  title: string;
  link: string;
  summary: string;
  publishedAt: string | null;
  author: string | null;
  image: string | null;
}

export interface ParsedFeed {
  title: string;
  entries: FeedEntry[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false,
  cdataPropName: '__cdata',
});

function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('__cdata' in record) return String(record.__cdata ?? '');
    if ('#text' in record) return String(record['#text'] ?? '');
  }
  return '';
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function linkFrom(entry: Record<string, unknown>): string {
  if (typeof entry.link === 'string') return entry.link;
  const links = toArray(entry.link as Record<string, unknown> | Record<string, unknown>[]);
  for (const link of links) {
    if (typeof link === 'string') return link;
    const href = link?.['@_href'];
    if (typeof href === 'string') return href;
  }
  return text(entry.id);
}

/** Parse RSS 2.0, Atom (Reddit) and YouTube feeds. */
export function parseFeed(xml: string): ParsedFeed {
  if (!xml || typeof xml !== 'string') return { title: 'Feed', entries: [] };
  let doc: Record<string, any>;
  try {
    doc = parser.parse(xml) as Record<string, any>;
  } catch {
    return { title: 'Feed', entries: [] };
  }

  if (doc.rss?.channel) {
    const channel = doc.rss.channel;
    const entries = toArray(channel.item).map((item: Record<string, unknown>, index: number): FeedEntry => {
      const guid = text(item.guid) || linkFrom(item) || `rss-${index}`;
      const media = (item['media:group'] ?? {}) as Record<string, unknown>;
      const thumbnail = (media['media:thumbnail'] ?? item['media:thumbnail'] ?? {}) as Record<string, unknown>;
      return {
        id: guid,
        title: text(item.title) || 'Untitled',
        link: linkFrom(item),
        summary: stripHtml(text(item.description) || text(item['content:encoded'])).slice(0, 600),
        publishedAt: text(item.pubDate) || text(item['dc:date']) || null,
        author: text(item['dc:creator']) || text(item.author) || null,
        image: typeof thumbnail['@_url'] === 'string' ? thumbnail['@_url'] : null,
      };
    });
    return { title: text(channel.title) || 'Feed', entries };
  }

  if (doc.feed) {
    const feed = doc.feed;
    const entries = toArray(feed.entry).map((entry: Record<string, unknown>, index: number): FeedEntry => {
      const media = (entry['media:group'] ?? {}) as Record<string, unknown>;
      const thumbnail = (media['media:thumbnail'] ?? {}) as Record<string, unknown>;
      const published = text(entry.published) || text(entry.updated);
      return {
        id: text(entry.id) || linkFrom(entry) || `atom-${index}`,
        title: text(entry.title) || 'Untitled',
        link: linkFrom(entry),
        summary: stripHtml(text(entry.content) || text(entry.summary)).slice(0, 600),
        publishedAt: published || null,
        author: text((entry.author as Record<string, unknown>)?.['name']) || null,
        image: typeof thumbnail['@_url'] === 'string' ? thumbnail['@_url'] : null,
      };
    });
    return { title: text(feed.title) || 'Feed', entries };
  }

  return { title: 'Feed', entries: [] };
}

/** Normalise a user-entered feed URL. Supports channel/user handles for YouTube. */
export function normalizeFeedUrl(input: string, type: string): string | null {
  const value = input.trim();
  if (!value) return null;
  if (type === 'youtube') {
    if (/^UC[\w-]{22}$/.test(value)) return `https://www.youtube.com/feeds/videos.xml?channel_id=${value}`;
    if (value.startsWith('@')) return `https://www.youtube.com/feeds/videos.xml?user=${value.slice(1)}`;
  }
  if (type === 'reddit' && /^\/?r\//i.test(value)) {
    const sub = value.replace(/^\/?r\//i, '').replace(/\/$/, '');
    return `https://www.reddit.com/r/${sub}/.rss`;
  }
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Only http(s) feed URLs may be fetched (SSRF guard). */
export function isSafeFeedUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    const host = url.hostname.toLowerCase();
    if (['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(host)) return false;
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}
