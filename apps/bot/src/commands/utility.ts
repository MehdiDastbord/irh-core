/** Utility slash commands: help, ping, config, logs, backups, emoji/sticker. */

import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { getModuleSettings, logger, prisma, requireGuildId } from '@irh/db';
import { formatDuration } from '@irh/shared';
import type { Command } from './index.js';
import { baseEmbed, COLORS, errorEmbed, successEmbed } from '../lib/embed.js';
import { commands } from './index.js';
import { env } from '../env.js';

const log = logger.child('commands');

export const utilityCommands: Command[] = [
  {
    data: new SlashCommandBuilder().setName('help').setDescription('List IRH CORE commands'),
    async execute(interaction) {
      const embed = baseEmbed({
        title: 'IRH CORE — command reference',
        description: 'Advanced configuration lives in the web dashboard. Commands are grouped below.',
        color: COLORS.brand,
        fields: [
          {
            name: '🛡 Moderation',
            value: '`/ban` `/kick` `/timeout` `/warn` `/purge` `/lock` `/unlock` `/mod`',
          },
          {
            name: '🎫 Community',
            value: '`/ticket` `/giveaway` `/poll` `/announce` `/embed`',
          },
          {
            name: '📈 Progression',
            value: '`/rank` `/leaderboard` `/stats` `/invites`',
          },
          {
            name: '⚙️ Utility',
            value: '`/config` `/setup` `/dashboard` `/logs` `/backup` `/emoji` `/sticker` `/help` `/ping`',
          },
        ],
        footer: `${commands.length} commands · ${env.appOrigin}`,
      });
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
  },
  {
    data: new SlashCommandBuilder().setName('ping').setDescription('Show latency and uptime'),
    async execute(interaction) {
      const start = Date.now();
      await interaction.reply({ content: 'Pinging…', flags: MessageFlags.Ephemeral });
      const roundTrip = Date.now() - start;
      const embed = baseEmbed({
        title: 'Pong',
        color: COLORS.success,
        fields: [
          { name: 'WebSocket', value: `${interaction.client.ws.ping} ms`, inline: true },
          { name: 'Round trip', value: `${roundTrip} ms`, inline: true },
          { name: 'Uptime', value: formatDuration(interaction.client.uptime ?? 0), inline: true },
        ],
      });
      await interaction.editReply({ content: null, embeds: [embed] });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('config')
      .setDescription('Show the configuration for a module')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setDMPermission(false)
      .addStringOption((option) =>
        option
          .setName('module')
          .setDescription('Module')
          .setRequired(true)
          .addChoices(
            { name: 'Moderation', value: 'moderation' },
            { name: 'Automod', value: 'automod' },
            { name: 'Security', value: 'security' },
            { name: 'Welcome', value: 'welcome' },
            { name: 'Tickets', value: 'tickets' },
            { name: 'Leveling', value: 'leveling' },
            { name: 'Giveaways', value: 'giveaways' },
            { name: 'Invites', value: 'invites' },
            { name: 'Logging', value: 'logging' },
          ),
      ),
    async execute(interaction) {
      if (!interaction.guild) return;
      const moduleId = interaction.options.getString('module', true);
      const settings = await getModuleSettings<Record<string, unknown>>(await requireGuildId(interaction.guild.id), moduleId);
      const lines = Object.entries(settings)
        .filter(([, value]) => value !== null && value !== undefined && value !== '' && (!Array.isArray(value) || value.length))
        .slice(0, 20)
        .map(([key, value]) => `**${key}:** ${typeof value === 'object' ? JSON.stringify(value).slice(0, 120) : String(value).slice(0, 120)}`);
      await interaction.reply({
        embeds: [
          baseEmbed({
            title: `${moduleId} configuration`,
            description: lines.join('\n') || 'No settings configured yet.\n\nUse the dashboard to configure this module.',
            footer: `${env.appOrigin}/dashboard/g/${interaction.guildId}`,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('logs')
      .setDescription('Search moderation and event history')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setDMPermission(false)
      .addStringOption((option) => option.setName('event').setDescription('Filter by event, e.g. mod.ban').setMaxLength(60))
      .addUserOption((option) => option.setName('user').setDescription('Filter by target member')),
    async execute(interaction) {
      if (!interaction.guild) return;
      const internalId = await requireGuildId(interaction.guild.id);
      const event = interaction.options.getString('event');
      const user = interaction.options.getUser('user');
      const rows = await prisma.loggingEvent.findMany({
        where: { guildId: internalId, ...(event ? { event } : {}), ...(user ? { targetId: user.id } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 15,
      });
      await interaction.reply({
        embeds: [
          baseEmbed({
            title: 'Recent events',
            description: rows.length
              ? rows.map((row) => `<t:${Math.floor(row.createdAt.getTime() / 1000)}:t> **${row.event}** — ${row.summary.slice(0, 160)}`).join('\n')
              : 'No events match that filter.',
            footer: `Export from ${env.appOrigin}/dashboard/g/${interaction.guildId}/audit`,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('backup')
      .setDescription('Create or list configuration backups')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .setDMPermission(false)
      .addSubcommand((sub) => sub.setName('create').setDescription('Create a backup now'))
      .addSubcommand((sub) => sub.setName('list').setDescription('List stored backups')),
    async execute(interaction) {
      if (!interaction.guild) return;
      const internalId = await requireGuildId(interaction.guild.id);
      const sub = interaction.options.getSubcommand(true);
      if (sub === 'create') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const { createBackup } = await import('@irh/db');
        const result = await createBackup({ guildId: internalId, name: `Manual backup ${new Date().toISOString().slice(0, 16)}`, createdById: interaction.user.id });
        await interaction.editReply({ embeds: [successEmbed('Backup created', `Backup \`${result.id}\` (${(result.sizeBytes / 1024).toFixed(1)} KB).`)] });
        return;
      }
      const backups = await prisma.backup.findMany({ where: { guildId: internalId }, orderBy: { createdAt: 'desc' }, take: 10 });
      await interaction.reply({
        embeds: [
          baseEmbed({
            title: 'Backups',
            description: backups.length
              ? backups.map((backup) => `\`${backup.id.slice(0, 8)}\` · ${backup.name} · ${(backup.sizeBytes / 1024).toFixed(1)} KB`).join('\n')
              : 'No backups yet.',
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('emoji')
      .setDescription('Emoji manager')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuildExpressions)
      .setDMPermission(false)
      .addSubcommand((sub) => sub.setName('list').setDescription('List server emojis'))
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Add a custom emoji')
          .addStringOption((option) => option.setName('emoji').setDescription('A custom emoji to copy, or an image URL').setRequired(true))
          .addStringOption((option) => option.setName('name').setDescription('Emoji name').setRequired(true).setMaxLength(32)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('rename')
          .setDescription('Rename an emoji')
          .addStringOption((option) => option.setName('emoji').setDescription('Emoji name').setRequired(true))
          .addStringOption((option) => option.setName('name').setDescription('New name').setRequired(true).setMaxLength(32)),
      )
      .addSubcommand((sub) =>
        sub.setName('remove').setDescription('Delete an emoji').addStringOption((option) => option.setName('emoji').setDescription('Emoji name').setRequired(true)),
      ),
    async execute(interaction) {
      if (!interaction.guild) return;
      const guild = interaction.guild;
      const sub = interaction.options.getSubcommand(true);
      const internalId = await requireGuildId(guild.id);

      if (sub === 'list') {
        const emojis = await guild.emojis.fetch();
        const list = [...emojis.values()].slice(0, 30).map((emoji) => `${emoji} \`${emoji.name}\``).join(' ');
        await interaction.reply({ embeds: [baseEmbed({ title: `Emojis (${emojis.size})`, description: list || 'No emojis.' })], flags: MessageFlags.Ephemeral });
        return;
      }

      if (sub === 'add') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const raw = interaction.options.getString('emoji', true);
        const name = interaction.options.getString('name', true).replace(/[^a-zA-Z0-9_]/g, '_');
        const match = /<(a?):([a-zA-Z0-9_]+):(\d+)>/.exec(raw);
        const url = match ? `https://cdn.discordapp.com/emojis/${match[3]}.${match[1] === 'a' ? 'gif' : 'png'}` : raw;
        try {
          const created = await guild.emojis.create({ attachment: url, name, reason: `Added by ${interaction.user.tag}` });
          await prisma.emojiRecord
            .upsert({
              where: { guildId_emojiId: { guildId: internalId, emojiId: created.id } },
              create: { guildId: internalId, emojiId: created.id, name: created.name, animated: Boolean(created.animated), url, addedById: interaction.user.id },
              update: { name: created.name },
            })
            .catch(() => undefined);
          await interaction.editReply({ embeds: [successEmbed('Emoji added', `${created} added as \`${created.name}\`.`)] });
        } catch (error) {
          log.warn('Emoji add failed', { guildId: guild.id, error: String(error) });
          await interaction.editReply({ embeds: [errorEmbed('Emoji', 'Could not add that emoji (invalid URL, size, or slot limit).')] });
        }
        return;
      }

      if (sub === 'rename') {
        const target = guild.emojis.cache.find((emoji) => emoji.name === interaction.options.getString('emoji', true));
        if (!target) {
          await interaction.reply({ embeds: [errorEmbed('Emoji', 'No emoji with that name.')], flags: MessageFlags.Ephemeral });
          return;
        }
        const name = interaction.options.getString('name', true).replace(/[^a-zA-Z0-9_]/g, '_');
        await target.setName(name, `Renamed by ${interaction.user.tag}`).catch(() => undefined);
        await interaction.reply({ embeds: [successEmbed('Emoji renamed', `Now \`${name}\`.`)], flags: MessageFlags.Ephemeral });
        return;
      }

      const target = guild.emojis.cache.find((emoji) => emoji.name === interaction.options.getString('emoji', true));
      if (!target) {
        await interaction.reply({ embeds: [errorEmbed('Emoji', 'No emoji with that name.')], flags: MessageFlags.Ephemeral });
        return;
      }
      await target.delete(`Deleted by ${interaction.user.tag}`).catch(() => undefined);
      await prisma.emojiRecord.deleteMany({ where: { guildId: internalId, emojiId: target.id } }).catch(() => undefined);
      await interaction.reply({ embeds: [successEmbed('Emoji removed', `\`${target.name}\` deleted.`)], flags: MessageFlags.Ephemeral });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('sticker')
      .setDescription('Sticker manager')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuildExpressions)
      .setDMPermission(false)
      .addSubcommand((sub) => sub.setName('list').setDescription('List server stickers'))
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('Add a sticker from a URL')
          .addStringOption((option) => option.setName('url').setDescription('PNG/APNG (320x320) URL').setRequired(true))
          .addStringOption((option) => option.setName('name').setDescription('Sticker name').setRequired(true).setMaxLength(30))
          .addStringOption((option) => option.setName('tags').setDescription('Related emoji/tag').setRequired(true).setMaxLength(20)),
      )
      .addSubcommand((sub) =>
        sub.setName('remove').setDescription('Delete a sticker').addStringOption((option) => option.setName('name').setDescription('Sticker name').setRequired(true)),
      ),
    async execute(interaction) {
      if (!interaction.guild) return;
      const guild = interaction.guild;
      const sub = interaction.options.getSubcommand(true);
      if (sub === 'list') {
        const stickers = await guild.stickers.fetch();
        await interaction.reply({
          embeds: [baseEmbed({ title: `Stickers (${stickers.size})`, description: [...stickers.values()].map((sticker) => `\`${sticker.name}\``).join(' ') || 'No stickers.' })],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (sub === 'add') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          const created = await guild.stickers.create({
            file: interaction.options.getString('url', true),
            name: interaction.options.getString('name', true),
            tags: interaction.options.getString('tags', true),
            reason: `Added by ${interaction.user.tag}`,
          });
          const internalId = await requireGuildId(guild.id);
          await prisma.stickerRecord
            .upsert({
              where: { guildId_stickerId: { guildId: internalId, stickerId: created.id } },
              create: { guildId: internalId, stickerId: created.id, name: created.name, format: String(created.format) },
              update: { name: created.name },
            })
            .catch(() => undefined);
          await interaction.editReply({ embeds: [successEmbed('Sticker added', `\`${created.name}\` added.`)] });
        } catch (error) {
          log.warn('Sticker add failed', { error: String(error) });
          await interaction.editReply({ embeds: [errorEmbed('Sticker', 'Could not add that sticker. Check the URL, format and slot limit.')] });
        }
        return;
      }
      const target = guild.stickers.cache.find((sticker) => sticker.name === interaction.options.getString('name', true));
      if (!target) {
        await interaction.reply({ embeds: [errorEmbed('Sticker', 'No sticker with that name.')], flags: MessageFlags.Ephemeral });
        return;
      }
      await target.delete(`Deleted by ${interaction.user.tag}`).catch(() => undefined);
      await interaction.reply({ embeds: [successEmbed('Sticker removed', `\`${target.name}\` deleted.`)], flags: MessageFlags.Ephemeral });
    },
  },
];

export type UtilityCommand = Command & { _channelTypes?: ChannelType[] };
export type UtilityInteraction = ChatInputCommandInteraction;
