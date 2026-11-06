/** Branded embed helpers. */

import { EmbedBuilder, type APIEmbed } from 'discord.js';
import type { EmbedSpec } from '@irh/shared';

export const COLORS = {
  brand: 0x5865f2,
  success: 0x2ecc71,
  warning: 0xf1c40f,
  danger: 0xe74c3c,
  info: 0x3ba3ff,
  muted: 0x2b2d42,
  purple: 0x9b59b6,
  security: 0xff4757,
} as const;

export const BRAND_FOOTER = 'IRH CORE';

export interface BaseEmbedOptions {
  title?: string;
  description?: string;
  color?: number;
  footer?: string;
  url?: string;
  thumbnail?: string;
  image?: string;
  author?: { name: string; iconURL?: string; url?: string };
  fields?: { name: string; value: string; inline?: boolean }[];
  timestamp?: boolean;
}

export function baseEmbed(options: BaseEmbedOptions = {}): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(options.color ?? COLORS.brand);
  if (options.title) embed.setTitle(options.title.slice(0, 256));
  if (options.description) embed.setDescription(options.description.slice(0, 4096));
  if (options.url) embed.setURL(options.url);
  if (options.thumbnail) embed.setThumbnail(options.thumbnail);
  if (options.image) embed.setImage(options.image);
  if (options.author) embed.setAuthor({ name: options.author.name.slice(0, 256), iconURL: options.author.iconURL, url: options.author.url });
  if (options.fields?.length) {
    embed.addFields(
      options.fields.slice(0, 25).map((field) => ({
        name: field.name.slice(0, 256) || '\u200b',
        value: field.value.slice(0, 1024) || '\u200b',
        inline: field.inline ?? false,
      })),
    );
  }
  if (options.timestamp !== false) embed.setTimestamp(new Date());
  embed.setFooter({ text: options.footer ?? BRAND_FOOTER });
  return embed;
}

export function successEmbed(title: string, description?: string): EmbedBuilder {
  return baseEmbed({ title, description, color: COLORS.success });
}

export function errorEmbed(title: string, description?: string): EmbedBuilder {
  return baseEmbed({ title, description, color: COLORS.danger });
}

export function warnEmbed(title: string, description?: string): EmbedBuilder {
  return baseEmbed({ title, description, color: COLORS.warning });
}

export function infoEmbed(title: string, description?: string): EmbedBuilder {
  return baseEmbed({ title, description, color: COLORS.info });
}

/** Convert a stored EmbedSpec into a discord.js EmbedBuilder. */
export function specToEmbed(spec: EmbedSpec, fallbackColor = COLORS.brand): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(spec.color ?? fallbackColor);
  if (spec.title) embed.setTitle(spec.title.slice(0, 256));
  if (spec.description) embed.setDescription(spec.description.slice(0, 4096));
  if (spec.url) embed.setURL(spec.url);
  if (spec.author) embed.setAuthor({ name: spec.author.name.slice(0, 256), iconURL: spec.author.iconURL, url: spec.author.url });
  if (spec.footer) embed.setFooter({ text: spec.footer.text.slice(0, 2048), iconURL: spec.footer.iconURL });
  if (spec.thumbnail) embed.setThumbnail(spec.thumbnail);
  if (spec.image) embed.setImage(spec.image);
  if (spec.timestamp !== false) embed.setTimestamp(new Date());
  if (spec.fields?.length) {
    embed.addFields(
      spec.fields.slice(0, 25).map((field) => ({
        name: field.name.slice(0, 256) || '\u200b',
        value: field.value.slice(0, 1024) || '\u200b',
        inline: field.inline ?? false,
      })),
    );
  }
  return embed;
}

export function toApiEmbed(embed: EmbedBuilder): APIEmbed {
  return embed.toJSON();
}

export function progressBar(percent: number, size = 12): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * size);
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, size - filled))}`;
}
