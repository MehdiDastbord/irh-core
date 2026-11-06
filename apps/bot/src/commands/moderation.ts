/** Moderation slash commands. */

import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
  type TextChannel,
} from 'discord.js';
import { getModuleSettings, prisma, requireGuildId } from '@irh/db';
import { formatDuration, parseDuration } from '@irh/shared';
import type { Command } from './index.js';
import { executePunishment, purgeMessages, setChannelLocked, buildCaseEmbed, punishmentFeedback } from '../modules/moderation.js';
import { baseEmbed, errorEmbed, infoEmbed, successEmbed, COLORS } from '../lib/embed.js';

async function actor(interaction: ChatInputCommandInteraction): Promise<GuildMember | null> {
  if (!interaction.guild) {
    await interaction.reply({ content: 'This command only works inside a server.', flags: MessageFlags.Ephemeral });
    return null;
  }
  return interaction.member as GuildMember;
}

function targetOf(interaction: ChatInputCommandInteraction): { member: GuildMember | null; id: string } {
  const user = interaction.options.getUser('user', true);
  const member = interaction.options.getMember('user') as GuildMember | null;
  return { member: member ?? null, id: user.id };
}

async function replyTo(interaction: ChatInputCommandInteraction, ok: boolean, message: string) {
  const embed = punishmentFeedback(ok, message);
  if (interaction.deferred || interaction.replied) await interaction.editReply({ embeds: [embed] });
  else await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

const reasonOption = (builder: import('discord.js').SlashCommandStringOption) =>
  builder.setName('reason').setDescription('Reason for the action').setMaxLength(400);

export const moderationCommands: Command[] = [
  {
    data: new SlashCommandBuilder()
      .setName('ban')
      .setDescription('Ban a member')
      .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
      .setDMPermission(false)
      .addUserOption((option) => option.setName('user').setDescription('Member to ban').setRequired(true))
      .addStringOption((option) => reasonOption(option))
      .addStringOption((option) => option.setName('duration').setDescription('Temporary ban, e.g. 7d (leave empty for permanent)').setMaxLength(20))
      .addIntegerOption((option) => option.setName('delete_messages').setDescription('Delete recent messages (days)').setMinValue(0).setMaxValue(7)),
    async execute(interaction) {
      if (!(await actor(interaction))) return;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { member, id } = targetOf(interaction);
      const duration = parseDuration(interaction.options.getString('duration') ?? '');
      const result = await executePunishment({
        guild: interaction.guild!,
        actor: interaction.member as GuildMember,
        target: member,
        targetId: id,
        action: 'ban',
        reason: interaction.options.getString('reason') ?? undefined,
        durationMs: duration ?? undefined,
        deleteMessageSeconds: (interaction.options.getInteger('delete_messages') ?? 0) * 86_400,
      });
      await replyTo(interaction, result.ok, result.message);
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('kick')
      .setDescription('Kick a member')
      .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
      .setDMPermission(false)
      .addUserOption((option) => option.setName('user').setDescription('Member to kick').setRequired(true))
      .addStringOption((option) => reasonOption(option)),
    async execute(interaction) {
      if (!(await actor(interaction))) return;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { member, id } = targetOf(interaction);
      const result = await executePunishment({
        guild: interaction.guild!,
        actor: interaction.member as GuildMember,
        target: member,
        targetId: id,
        action: 'kick',
        reason: interaction.options.getString('reason') ?? undefined,
      });
      await replyTo(interaction, result.ok, result.message);
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('timeout')
      .setDescription('Timeout a member')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .setDMPermission(false)
      .addUserOption((option) => option.setName('user').setDescription('Member to timeout').setRequired(true))
      .addStringOption((option) => option.setName('duration').setDescription('e.g. 10m, 2h, 7d').setRequired(true).setMaxLength(20))
      .addStringOption((option) => reasonOption(option)),
    async execute(interaction) {
      if (!(await actor(interaction))) return;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const duration = parseDuration(interaction.options.getString('duration', true));
      if (!duration) {
        await replyTo(interaction, false, 'Invalid duration. Use `10m`, `2h` or `7d`.');
        return;
      }
      const { member, id } = targetOf(interaction);
      const result = await executePunishment({
        guild: interaction.guild!,
        actor: interaction.member as GuildMember,
        target: member,
        targetId: id,
        action: 'timeout',
        reason: interaction.options.getString('reason') ?? undefined,
        durationMs: duration,
      });
      await replyTo(interaction, result.ok, result.message);
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('warn')
      .setDescription('Warn a member (escalates automatically)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .setDMPermission(false)
      .addUserOption((option) => option.setName('user').setDescription('Member to warn').setRequired(true))
      .addStringOption((option) => option.setName('reason').setDescription('Reason').setRequired(true).setMaxLength(400)),
    async execute(interaction) {
      if (!(await actor(interaction))) return;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { member, id } = targetOf(interaction);
      const result = await executePunishment({
        guild: interaction.guild!,
        actor: interaction.member as GuildMember,
        target: member,
        targetId: id,
        action: 'warn',
        reason: interaction.options.getString('reason', true),
      });
      await replyTo(interaction, result.ok, result.message);
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('purge')
      .setDescription('Delete recent messages')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .setDMPermission(false)
      .addIntegerOption((option) => option.setName('amount').setDescription('1-100').setRequired(true).setMinValue(1).setMaxValue(100))
      .addUserOption((option) => option.setName('user').setDescription('Only delete messages from this member')),
    async execute(interaction) {
      if (!(await actor(interaction))) return;
      const channel = interaction.channel as TextChannel | null;
      if (!channel?.isTextBased()) {
        await interaction.reply({ embeds: [errorEmbed('Purge', 'This channel does not support purging.')], flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const amount = interaction.options.getInteger('amount', true);
      const user = interaction.options.getUser('user');
      if (user) {
        const messages = await channel.messages.fetch({ limit: 100 });
        const filtered = messages.filter((message) => message.author.id === user.id).first(amount);
        await channel.bulkDelete(filtered, true).catch(() => undefined);
        await interaction.editReply({ embeds: [successEmbed('Purge', `Deleted ${filtered.length} message(s) from ${user.tag}.`)] });
        return;
      }
      const deleted = await purgeMessages(channel, amount, interaction.user.id);
      await interaction.editReply({ embeds: [successEmbed('Purge', `Deleted ${deleted} message(s).`)] });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('lock')
      .setDescription('Lock a channel')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
      .setDMPermission(false)
      .addChannelOption((option) => option.setName('channel').setDescription('Channel to lock')),
    async execute(interaction) {
      if (!(await actor(interaction))) return;
      const channel = (interaction.options.getChannel('channel') ?? interaction.channel) as TextChannel | null;
      if (!channel || !channel.isTextBased() || !('permissionOverwrites' in channel)) {
        await interaction.reply({ embeds: [errorEmbed('Lock', 'Choose a text channel.')], flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await setChannelLocked(channel, true, interaction.user.id);
      await interaction.editReply({ embeds: [successEmbed('Channel locked', `<#${channel.id}> is now read-only for @everyone.`)] });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('unlock')
      .setDescription('Unlock a channel')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
      .setDMPermission(false)
      .addChannelOption((option) => option.setName('channel').setDescription('Channel to unlock')),
    async execute(interaction) {
      if (!(await actor(interaction))) return;
      const channel = (interaction.options.getChannel('channel') ?? interaction.channel) as TextChannel | null;
      if (!channel || !channel.isTextBased() || !('permissionOverwrites' in channel)) {
        await interaction.reply({ embeds: [errorEmbed('Unlock', 'Choose a text channel.')], flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await setChannelLocked(channel, false, interaction.user.id);
      await interaction.editReply({ embeds: [successEmbed('Channel unlocked', `<#${channel.id}> is open again.`)] });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('mod')
      .setDescription('Moderation utilities')
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
      .setDMPermission(false)
      .addSubcommand((sub) =>
        sub.setName('case').setDescription('Show a moderation case').addIntegerOption((option) => option.setName('number').setDescription('Case number').setRequired(true).setMinValue(1)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('warnings')
          .setDescription('List active warnings')
          .addUserOption((option) => option.setName('user').setDescription('Member').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('note')
          .setDescription('Add a moderator note')
          .addUserOption((option) => option.setName('user').setDescription('Member').setRequired(true))
          .addStringOption((option) => option.setName('note').setDescription('Note').setRequired(true).setMaxLength(1000)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('slowmode')
          .setDescription('Set channel slowmode')
          .addStringOption((option) => option.setName('duration').setDescription('e.g. 10s, 1m, off').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('nickname')
          .setDescription('Change a nickname')
          .addUserOption((option) => option.setName('user').setDescription('Member').setRequired(true))
          .addStringOption((option) => option.setName('nickname').setDescription('New nickname (empty to reset)').setMaxLength(32)),
      ),
    async execute(interaction) {
      const member = await actor(interaction);
      if (!member) return;
      const internalId = await requireGuildId(interaction.guild!.id);
      const sub = interaction.options.getSubcommand(true);

      if (sub === 'case') {
        const caseNumber = interaction.options.getInteger('number', true);
        const record = await prisma.moderationCase.findUnique({ where: { guildId_caseNumber: { guildId: internalId, caseNumber } } });
        if (!record) {
          await interaction.reply({ embeds: [errorEmbed('Case not found', `No case #${caseNumber}.`)], flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.reply({ embeds: [buildCaseEmbed(record)] });
        return;
      }

      if (sub === 'warnings') {
        const user = interaction.options.getUser('user', true);
        const warnings = await prisma.warning.findMany({ where: { guildId: internalId, targetId: user.id, active: true }, orderBy: { createdAt: 'desc' }, take: 15 });
        const embed = baseEmbed({
          title: `Active warnings — ${user.tag}`,
          description: warnings.length
            ? warnings.map((warning) => `• <t:${Math.floor(warning.createdAt.getTime() / 1000)}:d> — ${warning.reason.slice(0, 120)}`).join('\n')
            : 'No active warnings.',
          color: warnings.length ? COLORS.warning : COLORS.success,
        });
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        return;
      }

      if (sub === 'note') {
        const user = interaction.options.getUser('user', true);
        const note = interaction.options.getString('note', true);
        await prisma.moderatorNote.create({ data: { guildId: internalId, targetId: user.id, authorId: interaction.user.id, note } });
        await interaction.reply({ embeds: [successEmbed('Note saved', `Added a moderator note for ${user.tag}.`)], flags: MessageFlags.Ephemeral });
        return;
      }

      if (sub === 'slowmode') {
        const raw = interaction.options.getString('duration', true);
        const channel = interaction.channel as TextChannel | null;
        if (!channel || !('setRateLimitPerUser' in channel)) {
          await interaction.reply({ embeds: [errorEmbed('Slowmode', 'Not available in this channel.')], flags: MessageFlags.Ephemeral });
          return;
        }
        if (raw.toLowerCase() === 'off' || raw === '0') {
          await channel.setRateLimitPerUser(0);
          await interaction.reply({ embeds: [successEmbed('Slowmode off', 'Slowmode disabled.')] });
          return;
        }
        const ms = parseDuration(raw);
        if (!ms || ms > 21_600_000) {
          await interaction.reply({ embeds: [errorEmbed('Slowmode', 'Use a duration between 1s and 6h.')], flags: MessageFlags.Ephemeral });
          return;
        }
        await channel.setRateLimitPerUser(Math.floor(ms / 1000));
        await interaction.reply({ embeds: [successEmbed('Slowmode set', `Slowmode is now ${formatDuration(ms)}.`)] });
        return;
      }

      const user = interaction.options.getUser('user', true);
      const target = await interaction.guild!.members.fetch(user.id).catch(() => null);
      if (!target) {
        await interaction.reply({ embeds: [errorEmbed('Member not found', 'That member is not in this server.')], flags: MessageFlags.Ephemeral });
        return;
      }
      if (target.id === interaction.guild!.ownerId) {
        await interaction.reply({ embeds: [errorEmbed('Not allowed', 'The owner cannot be renamed.')], flags: MessageFlags.Ephemeral });
        return;
      }
      const nickname = interaction.options.getString('nickname') ?? null;
      await target.setNickname(nickname, `By ${interaction.user.tag}`).catch(() => undefined);
      await interaction.reply({ embeds: [successEmbed('Nickname updated', nickname ? `Nickname set to **${nickname}**.` : 'Nickname reset.')], flags: MessageFlags.Ephemeral });
      void getModuleSettings;
      void infoEmbed;
    },
  },
];
