/** Community slash commands: tickets, giveaways, levels, invites, polls, announcements. */

import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type TextChannel,
} from 'discord.js';
import { getModuleSettings, prisma, requireGuildId, xpLeaderboard } from '@irh/db';
import { formatDuration, parseDuration } from '@irh/shared';
import type { Command } from './index.js';
import { baseEmbed, COLORS, errorEmbed, successEmbed } from '../lib/embed.js';
import { closeTicket, openTicket, ticketSettings } from '../modules/tickets.js';
import { endGiveaway, giveawayComponents, giveawayEmbed, startGiveaway } from '../modules/giveaways.js';
import { memberRankData, rankEmbed } from '../modules/leveling.js';
import { inviteLeaderboard } from '../modules/invites.js';
import { env } from '../env.js';

const inGuild = async (interaction: ChatInputCommandInteraction): Promise<boolean> => {
  if (interaction.guild) return true;
  await interaction.reply({ content: 'This command only works inside a server.', flags: MessageFlags.Ephemeral });
  return false;
};

export const communityCommands: Command[] = [
  {
    data: new SlashCommandBuilder()
      .setName('ticket')
      .setDescription('Ticket controls')
      .setDMPermission(false)
      .addSubcommand((sub) => sub.setName('open').setDescription('Open a support ticket').addStringOption((option) => option.setName('subject').setDescription('What do you need help with?').setMaxLength(120)))
      .addSubcommand((sub) => sub.setName('close').setDescription('Close this ticket').addStringOption((option) => option.setName('reason').setDescription('Reason').setMaxLength(200)))
      .addSubcommand((sub) => sub.setName('claim').setDescription('Claim this ticket'))
      .addSubcommand((sub) =>
        sub.setName('add').setDescription('Add a member to this ticket').addUserOption((option) => option.setName('user').setDescription('Member').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub.setName('remove').setDescription('Remove a member from this ticket').addUserOption((option) => option.setName('user').setDescription('Member').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub.setName('rename').setDescription('Rename this ticket').addStringOption((option) => option.setName('name').setDescription('New name').setRequired(true).setMaxLength(90)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('priority')
          .setDescription('Set ticket priority')
          .addStringOption((option) =>
            option.setName('level').setDescription('Priority').setRequired(true).addChoices(
              { name: 'Low', value: 'low' },
              { name: 'Normal', value: 'normal' },
              { name: 'High', value: 'high' },
              { name: 'Urgent', value: 'urgent' },
            ),
          ),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('Show open tickets')),
    async execute(interaction) {
      if (!(await inGuild(interaction))) return;
      const guild = interaction.guild!;
      const sub = interaction.options.getSubcommand(true);
      const internalId = await requireGuildId(guild.id);

      if (sub === 'open') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const member = await guild.members.fetch(interaction.user.id);
        const result = await openTicket({ guild, member, subject: interaction.options.getString('subject') ?? 'Support request' });
        await interaction.editReply({ embeds: [result.ok ? successEmbed('Ticket opened', result.message) : errorEmbed('Ticket', result.message)] });
        return;
      }

      const ticket = await prisma.ticket.findFirst({ where: { guildId: internalId, channelId: interaction.channelId } });
      if (!ticket) {
        await interaction.reply({ embeds: [errorEmbed('Not a ticket', 'Run this inside a ticket channel.')], flags: MessageFlags.Ephemeral });
        return;
      }

      if (sub === 'close') {
        await interaction.reply({ embeds: [baseEmbed({ title: 'Closing ticket', color: COLORS.muted })], flags: MessageFlags.Ephemeral });
        await closeTicket({ guild, channelId: ticket.channelId, actorId: interaction.user.id, reason: interaction.options.getString('reason') ?? undefined });
        return;
      }

      if (sub === 'claim') {
        await prisma.ticket.update({ where: { id: ticket.id }, data: { status: 'claimed', claimedById: interaction.user.id } });
        await interaction.reply({ embeds: [successEmbed('Claimed', `<@${interaction.user.id}> is handling this ticket.`)] });
        return;
      }

      if (sub === 'add' || sub === 'remove') {
        const user = interaction.options.getUser('user', true);
        const channel = interaction.channel as TextChannel | null;
        if (!channel || !('permissionOverwrites' in channel)) return;
        if (sub === 'add') {
          await channel.permissionOverwrites.edit(user.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
          await interaction.reply({ embeds: [successEmbed('Member added', `${user} can now see this ticket.`)] });
        } else {
          await channel.permissionOverwrites.delete(user.id).catch(() => undefined);
          await interaction.reply({ embeds: [successEmbed('Member removed', `${user} no longer has access.`)] });
        }
        return;
      }

      if (sub === 'rename') {
        const name = interaction.options.getString('name', true).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 90);
        const channel = interaction.channel as TextChannel | null;
        if (!channel || !('setName' in channel)) return;
        await channel.setName(name, `Renamed by ${interaction.user.tag}`);
        await interaction.reply({ embeds: [successEmbed('Renamed', `This ticket is now **${name}**.`)] });
        return;
      }

      if (sub === 'priority') {
        const level = interaction.options.getString('level', true);
        await prisma.ticket.update({ where: { id: ticket.id }, data: { priority: level } });
        await interaction.reply({ embeds: [successEmbed('Priority updated', `Set to **${level}**.`)] });
        return;
      }

      const tickets = await prisma.ticket.findMany({ where: { guildId: internalId, status: { in: ['open', 'claimed'] } }, take: 20, orderBy: { createdAt: 'desc' } });
      await interaction.reply({
        embeds: [
          baseEmbed({
            title: 'Open tickets',
            description: tickets.length ? tickets.map((entry) => `#${entry.number} · <#${entry.channelId}> · ${entry.status}`).join('\n') : 'No open tickets.',
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('giveaway')
      .setDescription('Giveaway controls')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setDMPermission(false)
      .addSubcommand((sub) =>
        sub
          .setName('start')
          .setDescription('Start a giveaway')
          .addStringOption((option) => option.setName('prize').setDescription('Prize').setRequired(true).setMaxLength(200))
          .addStringOption((option) => option.setName('duration').setDescription('e.g. 1h, 7d').setRequired(true))
          .addIntegerOption((option) => option.setName('winners').setDescription('Number of winners').setMinValue(1).setMaxValue(50))
          .addChannelOption((option) => option.setName('channel').setDescription('Channel').addChannelTypes(ChannelType.GuildText)),
      )
      .addSubcommand((sub) => sub.setName('end').setDescription('End the latest giveaway in this channel'))
      .addSubcommand((sub) => sub.setName('reroll').setDescription('Reroll the latest ended giveaway in this channel').addIntegerOption((option) => option.setName('count').setDescription('Winners').setMinValue(1).setMaxValue(20)))
      .addSubcommand((sub) => sub.setName('pause').setDescription('Pause or resume the latest giveaway in this channel'))
      .addSubcommand((sub) => sub.setName('list').setDescription('List active giveaways')),
    async execute(interaction) {
      if (!(await inGuild(interaction))) return;
      const guild = interaction.guild!;
      const internalId = await requireGuildId(guild.id);
      const settings = await getModuleSettings<{ enabled: boolean; defaultWinners: number; defaultDurationMs: number; requiredRoleIds: string[]; bonusRoleIds: string[]; minAccountAgeDays: number; minServerAgeDays: number }>(internalId, 'giveaways');
      if (!settings.enabled) {
        await interaction.reply({ embeds: [errorEmbed('Giveaways disabled', 'Enable giveaways from the dashboard.')], flags: MessageFlags.Ephemeral });
        return;
      }
      const sub = interaction.options.getSubcommand(true);

      if (sub === 'start') {
        const duration = parseDuration(interaction.options.getString('duration', true));
        if (!duration || duration < 10_000) {
          await interaction.reply({ embeds: [errorEmbed('Giveaway', 'Duration must be at least 10 seconds.')], flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const channel = (interaction.options.getChannel('channel') ?? interaction.channel) as TextChannel;
        const giveaway = await prisma.giveaway.create({
          data: {
            guildId: internalId,
            channelId: channel.id,
            prize: interaction.options.getString('prize', true),
            winnerCount: interaction.options.getInteger('winners') ?? settings.defaultWinners ?? 1,
            hostId: interaction.user.id,
            winners: [] as never,
            requiredRoleIds: (settings.requiredRoleIds ?? []) as never,
            bonusRoles: (settings.bonusRoleIds ?? []) as never,
            minAccountAgeDays: settings.minAccountAgeDays ?? 0,
            minServerAgeDays: settings.minServerAgeDays ?? 0,
            endsAt: new Date(Date.now() + duration),
            status: 'running',
          },
        });
        const { enqueueJob } = await import('@irh/db');
        await enqueueJob({ type: 'giveaway.end', guildId: internalId, payload: { giveawayId: giveaway.id }, runAt: giveaway.endsAt, dedupeKey: `giveaway.end:${giveaway.id}` });
        await startGiveaway(interaction.client, giveaway.id);
        const fresh = await prisma.giveaway.findUnique({ where: { id: giveaway.id } });
        void fresh;
        await interaction.editReply({ embeds: [successEmbed('Giveaway started', `**${giveaway.prize}** ends in ${formatDuration(duration)} in <#${channel.id}>.`)] });
        return;
      }

      const latest = await prisma.giveaway.findFirst({
        where: { guildId: internalId, channelId: interaction.channelId, ...(sub === 'reroll' ? { status: 'ended' } : {}) },
        orderBy: { createdAt: 'desc' },
      });
      if (!latest) {
        await interaction.reply({ embeds: [errorEmbed('No giveaway', 'There is no matching giveaway in this channel.')], flags: MessageFlags.Ephemeral });
        return;
      }

      if (sub === 'end') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await endGiveaway(latest.id);
        await interaction.editReply({
          embeds: [successEmbed('Giveaway ended', result?.winners.length ? `Winners: ${result.winners.map((id) => `<@${id}>`).join(', ')}` : 'No valid entries.')],
        });
        return;
      }

      if (sub === 'reroll') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await endGiveaway(latest.id, { reroll: true, rerollCount: interaction.options.getInteger('count') ?? 1 });
        await interaction.editReply({ embeds: [successEmbed('Rerolled', result?.winners.length ? `New winners: ${result.winners.map((id) => `<@${id}>`).join(', ')}` : 'No valid entries.')] });
        return;
      }

      if (sub === 'pause') {
        if (latest.status === 'paused') {
          const pausedFor = latest.pausedAt ? Date.now() - latest.pausedAt.getTime() : 0;
          const updated = await prisma.giveaway.update({
            where: { id: latest.id },
            data: { status: 'running', pausedAt: null, totalPausedMs: latest.totalPausedMs + pausedFor, endsAt: new Date(latest.endsAt.getTime() + pausedFor) },
          });
          const { enqueueJob } = await import('@irh/db');
          await enqueueJob({ type: 'giveaway.end', guildId: internalId, payload: { giveawayId: latest.id }, runAt: updated.endsAt, dedupeKey: `giveaway.end:${latest.id}` });
          await interaction.reply({ embeds: [successEmbed('Resumed', 'Giveaway resumed.')] });
        } else {
          await prisma.giveaway.update({ where: { id: latest.id }, data: { status: 'paused', pausedAt: new Date() } });
          await interaction.reply({ embeds: [successEmbed('Paused', 'Giveaway paused.')] });
        }
        return;
      }

      const active = await prisma.giveaway.findMany({ where: { guildId: internalId, status: { in: ['running', 'paused', 'scheduled'] } }, take: 15 });
      await interaction.reply({
        embeds: [
          baseEmbed({
            title: 'Active giveaways',
            description: active.length ? active.map((entry) => `**${entry.prize}** · <#${entry.channelId}> · ${entry.status}`).join('\n') : 'No active giveaways.',
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('rank')
      .setDescription('Show your level or another member’s level')
      .setDMPermission(false)
      .addUserOption((option) => option.setName('user').setDescription('Member')),
    async execute(interaction) {
      if (!(await inGuild(interaction))) return;
      const user = interaction.options.getUser('user') ?? interaction.user;
      const data = await memberRankData(interaction.guild!.id, user.id);
      if (!data) {
        await interaction.reply({ embeds: [baseEmbed({ title: 'No XP yet', description: `${user.username} has not gained XP yet.` })], flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.reply({
        embeds: [
          rankEmbed({
            username: user.username,
            avatarUrl: user.displayAvatarURL(),
            xp: data.xp,
            rank: data.rank,
            level: data.level,
            messages: data.messages,
            voiceSeconds: data.voiceSeconds,
          }),
        ],
      });
    },
  },
  {
    data: new SlashCommandBuilder().setName('leaderboard').setDescription('Show the XP leaderboard').setDMPermission(false),
    async execute(interaction) {
      if (!(await inGuild(interaction))) return;
      const internalId = await requireGuildId(interaction.guild!.id);
      const rows = await xpLeaderboard(internalId, 10);
      await interaction.reply({
        embeds: [
          baseEmbed({
            title: '🏆 Leaderboard',
            description: rows.length
              ? rows.map((row, index) => `**${index + 1}.** <@${row.discordId}> — level ${row.level} · ${row.xp} XP`).join('\n')
              : 'No XP recorded yet.',
            color: COLORS.purple,
          }),
        ],
      });
    },
  },
  {
    data: new SlashCommandBuilder().setName('stats').setDescription('Server statistics').setDMPermission(false),
    async execute(interaction) {
      if (!(await inGuild(interaction))) return;
      const guild = interaction.guild!;
      const internalId = await requireGuildId(guild.id);
      const [tickets, xp, invites, cases] = await Promise.all([
        prisma.ticket.count({ where: { guildId: internalId, status: { in: ['open', 'claimed'] } } }),
        prisma.xPRecord.count({ where: { guildId: internalId } }),
        prisma.inviteEvent.count({ where: { guildId: internalId, type: 'join', fake: false } }),
        prisma.moderationCase.count({ where: { guildId: internalId } }),
      ]);
      await interaction.reply({
        embeds: [
          baseEmbed({
            title: `${guild.name} statistics`,
            thumbnail: guild.iconURL() ?? undefined,
            fields: [
              { name: 'Members', value: String(guild.memberCount), inline: true },
              { name: 'Boosts', value: String(guild.premiumSubscriptionCount ?? 0), inline: true },
              { name: 'Open tickets', value: String(tickets), inline: true },
              { name: 'Tracked members (XP)', value: String(xp), inline: true },
              { name: 'Invite joins', value: String(invites), inline: true },
              { name: 'Moderation cases', value: String(cases), inline: true },
            ],
          }),
        ],
      });
    },
  },
  {
    data: new SlashCommandBuilder().setName('invites').setDescription('Invite leaderboard').setDMPermission(false),
    async execute(interaction) {
      if (!(await inGuild(interaction))) return;
      const rows = await inviteLeaderboard(interaction.guild!.id, 10);
      await interaction.reply({
        embeds: [
          baseEmbed({
            title: '📨 Invite leaderboard',
            description: rows.length ? rows.map((row, index) => `**${index + 1}.** <@${row.inviterId}> — ${row.joins} join(s)`).join('\n') : 'No invite data yet.',
            footer: 'Fake invites are excluded',
          }),
        ],
      });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('poll')
      .setDescription('Create a quick poll')
      .setDMPermission(false)
      .addStringOption((option) => option.setName('question').setDescription('Question').setRequired(true).setMaxLength(200))
      .addStringOption((option) => option.setName('options').setDescription('Comma separated, 2-10 options').setRequired(true).setMaxLength(500)),
    async execute(interaction) {
      if (!(await inGuild(interaction))) return;
      const options = interaction.options
        .getString('options', true)
        .split(',')
        .map((option) => option.trim())
        .filter(Boolean)
        .slice(0, 10);
      if (options.length < 2) {
        await interaction.reply({ embeds: [errorEmbed('Poll', 'Provide at least two options separated by commas.')], flags: MessageFlags.Ephemeral });
        return;
      }
      const numbers = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
      const embed = baseEmbed({
        title: `📊 ${interaction.options.getString('question', true)}`,
        description: options.map((option, index) => `${numbers[index]} ${option}`).join('\n'),
        fields: [{ name: 'Vote', value: 'React with the matching number.', inline: false }],
        footer: `Poll by ${interaction.user.tag}`,
      });
      const message = await interaction.reply({ embeds: [embed], fetchReply: true });
      for (let index = 0; index < options.length; index += 1) await message.react(numbers[index]!).catch(() => undefined);
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('embed')
      .setDescription('Send a custom embed')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .setDMPermission(false)
      .addStringOption((option) => option.setName('title').setDescription('Title').setRequired(true).setMaxLength(256))
      .addStringOption((option) => option.setName('description').setDescription('Body').setRequired(true).setMaxLength(4000))
      .addStringOption((option) => option.setName('color').setDescription('Hex color, e.g. #5865f2').setMaxLength(7))
      .addChannelOption((option) => option.setName('channel').setDescription('Destination').addChannelTypes(ChannelType.GuildText)),
    async execute(interaction) {
      if (!(await inGuild(interaction))) return;
      const colorRaw = interaction.options.getString('color') ?? '#5865f2';
      const color = Number.parseInt(colorRaw.replace('#', ''), 16);
      const channel = (interaction.options.getChannel('channel') ?? interaction.channel) as TextChannel;
      const embed = new EmbedBuilder()
        .setTitle(interaction.options.getString('title', true))
        .setDescription(interaction.options.getString('description', true))
        .setColor(Number.isFinite(color) ? color : COLORS.brand)
        .setFooter({ text: `By ${interaction.user.tag}` })
        .setTimestamp(new Date());
      await channel.send({ embeds: [embed] });
      await interaction.reply({ embeds: [successEmbed('Embed sent', `Posted in <#${channel.id}>.`)], flags: MessageFlags.Ephemeral });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('announce')
      .setDescription('Send an announcement')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setDMPermission(false)
      .addStringOption((option) => option.setName('message').setDescription('Announcement body').setRequired(true).setMaxLength(3000))
      .addStringOption((option) => option.setName('title').setDescription('Title').setMaxLength(200))
      .addRoleOption((option) => option.setName('role').setDescription('Role to mention'))
      .addChannelOption((option) => option.setName('channel').setDescription('Destination').addChannelTypes(ChannelType.GuildText)),
    async execute(interaction) {
      if (!(await inGuild(interaction))) return;
      const role = interaction.options.getRole('role');
      const channel = (interaction.options.getChannel('channel') ?? interaction.channel) as TextChannel;
      await channel.send({
        content: role ? `<@&${role.id}>` : undefined,
        embeds: [
          baseEmbed({
            title: interaction.options.getString('title') ?? '📣 Announcement',
            description: interaction.options.getString('message', true),
            footer: `By ${interaction.user.tag}`,
          }),
        ],
        allowedMentions: { roles: role ? [role.id] : [] },
      });
      await interaction.reply({ embeds: [successEmbed('Announcement sent', `Posted in <#${channel.id}>.`)], flags: MessageFlags.Ephemeral });
    },
  },
  {
    data: new SlashCommandBuilder().setName('dashboard').setDescription('Open the IRH CORE dashboard').setDMPermission(false),
    async execute(interaction) {
      if (!(await inGuild(interaction))) return;
      await interaction.reply({
        embeds: [
          baseEmbed({
            title: 'IRH CORE dashboard',
            description: `Manage **${interaction.guild!.name}** at ${env.appOrigin}/dashboard/g/${interaction.guildId}`,
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
  {
    data: new SlashCommandBuilder().setName('setup').setDescription('Show the setup checklist').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild).setDMPermission(false),
    async execute(interaction) {
      if (!(await inGuild(interaction))) return;
      const internalId = await requireGuildId(interaction.guild!.id);
      const settings = await prisma.guildSetting.findMany({ where: { guildId: internalId } });
      const configured = new Set(settings.map((row) => row.moduleId));
      const checklist = ['welcome', 'verification', 'logging', 'moderation', 'automod', 'security', 'tickets', 'leveling', 'giveaways', 'invites']
        .map((module) => `${configured.has(module) ? '✅' : '⬜'} ${module}`)
        .join('\n');
      await interaction.reply({
        embeds: [
          baseEmbed({
            title: 'Setup checklist',
            description: `${checklist}\n\nFinish configuration at ${env.appOrigin}/dashboard/g/${interaction.guildId}`,
            footer: 'IRH CORE setup',
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
      void ticketSettings;
      void giveawayEmbed;
      void giveawayComponents;
    },
  },
];
