/** RSS / YouTube / Reddit feed polling with duplicate detection. */

import { isSafeFeedUrl, parseFeed, type FeedEntry } from '@irh/shared/feed';
import { getModuleSettings, logger, prisma, requireGuildId } from '@irh/db';
import type { Client } from 'discord.js';
import { baseEmbed, COLORS } from '../lib/embed.js';
import { emitLog } from '../lib/logging.js';

const log = logger.child('feeds');

export interface FeedSettings {
  enabled: boolean;
  checkIntervalMinutes: number;
  defaultChannelId: string | null;
  mentionRoleIds: string[];
  maxEntriesPerPoll: number;
  errorThreshold: number;
}

/** Pick entries newer than the last published guid. Pure for tests. */
export function newEntries(entries: FeedEntry[], lastGuid: string | null, limit: number): FeedEntry[] {
  if (!entries.length) return [];
  if (!lastGuid) return entries.slice(0, limit);
  const index = entries.findIndex((entry) => entry.id === lastGuid);
  if (index === -1) return entries.slice(0, limit);
  return entries.slice(0, index).reverse().slice(-limit);
}

export async function pollGuildFeeds(client: Client, guildId: string): Promise<{ checked: number; published: number }> {
  const internalId = await requireGuildId(guildId);
  const settings = await getModuleSettings<FeedSettings>(internalId, 'rss');
  if (!settings.enabled) return { checked: 0, published: 0 };
  const feeds = await prisma.rSSFeed.findMany({ where: { guildId: internalId, enabled: true } });
  let published = 0;

  for (const feed of feeds) {
    if (!isSafeFeedUrl(feed.url)) {
      await prisma.rSSFeed.update({ where: { id: feed.id }, data: { lastError: 'Blocked URL', enabled: false } });
      continue;
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12_000);
      const response = await fetch(feed.url, {
        signal: controller.signal,
        headers: { 'user-agent': 'IRH-CORE/1.0 (+feed reader)', accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
      });
      clearTimeout(timeout);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const parsed = parseFeed(await response.text());
      const entries = newEntries(parsed.entries, feed.lastGuid, settings.maxEntriesPerPoll ?? 3);
      const channel = await client.channels.fetch(feed.channelId).catch(() => null);
      if (!channel || !channel.isTextBased() || !('send' in channel)) {
        throw new Error('Destination channel unavailable');
      }

      for (const entry of entries.reverse()) {
        await channel.send({
          content: ((feed.mentionRoleIds as string[]) ?? []).map((roleId) => `<@&${roleId}>`).join(' ') || undefined,
          embeds: [
            baseEmbed({
              title: entry.title,
              url: entry.link || undefined,
              description: entry.summary ? entry.summary.slice(0, 1500) : undefined,
              color: COLORS.info,
              footer: feed.label ?? parsed.title,
              thumbnail: entry.image ?? undefined,
            }),
          ],
          allowedMentions: { roles: (feed.mentionRoleIds as string[]) ?? [] },
        });
        published += 1;
      }

      await prisma.rSSFeed.update({
        where: { id: feed.id },
        data: {
          lastGuid: parsed.entries[0]?.id ?? feed.lastGuid,
          lastPublishedAt: published ? new Date() : feed.lastPublishedAt,
          errorCount: 0,
          lastError: null,
        },
      });
      const logGuild = channel.isDMBased() ? null : channel.guild;
      if (entries.length && logGuild) {
        await emitLog({
          guild: logGuild,
          event: 'feed.posted',
          summary: `Published ${entries.length} new entr${entries.length === 1 ? 'y' : 'ies'} from **${parsed.title}**`,
          channelId: feed.channelId,
        }).catch(() => undefined);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorCount = feed.errorCount + 1;
      log.warn('Feed poll failed', { feedId: feed.id, url: feed.url, error: message });
      await prisma.rSSFeed.update({
        where: { id: feed.id },
        data: { lastError: message.slice(0, 300), errorCount, ...(errorCount >= (settings.errorThreshold ?? 10) ? { enabled: false } : {}) },
      });
    }
  }

  return { checked: feeds.length, published };
}

export async function pollAllFeeds(client: Client): Promise<{ checked: number; published: number }> {
  const guilds = await prisma.guild.findMany({ where: { botJoinedAt: { gt: new Date(0) } }, select: { discordId: true } });
  let checked = 0;
  let published = 0;
  for (const guild of guilds) {
    const result = await pollGuildFeeds(client, guild.discordId).catch(() => ({ checked: 0, published: 0 }));
    checked += result.checked;
    published += result.published;
  }
  return { checked, published };
}
