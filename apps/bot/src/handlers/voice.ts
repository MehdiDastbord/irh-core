/** Voice: logging, voice XP, Voice Master temporary channels and controls. */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Events,
  PermissionFlagsBits,
  type ButtonInteraction,
  type Client,
  type VoiceChannel,
  type VoiceState,
} from 'discord.js';
import { getModuleSettings, logger, prisma, requireGuildId } from '@irh/db';
import { renderTemplate } from '@irh/shared';
import { emitLog } from '../lib/logging.js';
import { baseEmbed, COLORS, errorEmbed, successEmbed } from '../lib/embed.js';
import { awardVoiceXp } from '../modules/leveling.js';
import { safeSend } from '../lib/discord-utils.js';

const log = logger.child('voice');

const joinTimes = new Map<string, number>();

export interface VoiceMasterSettings {
  enabled: boolean;
  hubChannelId: string | null;
  categoryId: string | null;
  namingTemplate: string;
  defaultUserLimit: number;
  deleteWhenEmptySeconds: number;
  allowClaim: boolean;
  allowTransfer: boolean;
  voiceStatsEnabled: boolean;
}

export function voiceControls() {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('vm:lock').setLabel('Lock').setStyle(ButtonStyle.Secondary).setEmoji('🔒'),
      new ButtonBuilder().setCustomId('vm:unlock').setLabel('Unlock').setStyle(ButtonStyle.Secondary).setEmoji('🔓'),
      new ButtonBuilder().setCustomId('vm:hide').setLabel('Hide').setStyle(ButtonStyle.Secondary).setEmoji('🙈'),
      new ButtonBuilder().setCustomId('vm:unhide').setLabel('Reveal').setStyle(ButtonStyle.Secondary).setEmoji('👁'),
      new ButtonBuilder().setCustomId('vm:claim').setLabel('Claim').setStyle(ButtonStyle.Primary).setEmoji('👑'),
      new ButtonBuilder().setCustomId('vm:kick').setLabel('Kick').setStyle(ButtonStyle.Danger).setEmoji('👢'),
    ),
  ];
}

export function registerVoiceHandlers(client: Client): void {
  client.on(Events.VoiceStateUpdate, async (before: VoiceState, after: VoiceState) => {
    const guild = after.guild ?? before.guild;
    if (!guild) return;

    try {
      // ── voice activity logging & XP ─────────────────────────
      if (!before.channelId && after.channelId) {
        joinTimes.set(`${guild.id}:${after.id}`, Date.now());
        await emitLog({
          guild,
          event: 'voice.join',
          summary: `${after.member?.user.tag ?? after.id} joined <#${after.channelId}>`,
          targetId: after.id,
          channelId: after.channelId,
        });
      } else if (before.channelId && !after.channelId) {
        const key = `${guild.id}:${after.id}`;
        const started = joinTimes.get(key);
        joinTimes.delete(key);
        if (started && after.member) {
          const minutes = (Date.now() - started) / 60_000;
          const internalId = await requireGuildId(guild.id);
          await prisma.xPRecord
            .updateMany({ where: { guildId: internalId, discordId: after.id }, data: { voiceSeconds: { increment: Math.round(minutes * 60) } } })
            .catch(() => undefined);
          const leveling = await getModuleSettings<{ voiceXpPerMinute: number }>(internalId, 'leveling');
          if (leveling.voiceXpPerMinute > 0 && minutes >= 1) await awardVoiceXp(after.member, minutes).catch(() => undefined);
        }
        await emitLog({
          guild,
          event: 'voice.leave',
          summary: `${after.member?.user.tag ?? after.id} left <#${before.channelId}>`,
          targetId: after.id,
          channelId: before.channelId,
        });
      } else if (before.channelId && after.channelId && before.channelId !== after.channelId) {
        await emitLog({
          guild,
          event: 'voice.move',
          summary: `${after.member?.user.tag ?? after.id} moved from <#${before.channelId}> to <#${after.channelId}>`,
          targetId: after.id,
          channelId: after.channelId,
        });
      }

      // ── Voice Master: create on hub join ────────────────────
      const internalId = await requireGuildId(guild.id);
      const settings = await getModuleSettings<VoiceMasterSettings>(internalId, 'voicemaster');
      if (!settings.enabled || !settings.hubChannelId) return;

      if (after.channelId === settings.hubChannelId && after.member) {
        const existing = await prisma.voiceMasterChannel.findFirst({ where: { guildId: internalId, ownerId: after.member.id } });
        if (existing) {
          const channel = await guild.channels.fetch(existing.channelId).catch(() => null);
          if (channel?.isVoiceBased()) {
            await after.member.voice.setChannel(channel.id).catch(() => undefined);
            return;
          }
          await prisma.voiceMasterChannel.delete({ where: { id: existing.id } }).catch(() => undefined);
        }

        const name = renderTemplate(settings.namingTemplate || "{username}'s channel", {
          userName: after.member.user.username,
          userTag: after.member.user.tag,
          memberCount: guild.members.cache.filter((member) => member.voice.channelId).size,
        }).slice(0, 90);

        try {
          const channel = (await guild.channels.create({
            name,
            type: ChannelType.GuildVoice,
            ...(settings.categoryId ? { parent: settings.categoryId } : after.channel?.parentId ? { parent: after.channel.parentId } : {}),
            userLimit: settings.defaultUserLimit || 0,
            permissionOverwrites: [
              { id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
              {
                id: after.member.id,
                allow: [
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.Connect,
                  PermissionFlagsBits.ManageChannels,
                  PermissionFlagsBits.MoveMembers,
                  PermissionFlagsBits.MuteMembers,
                ],
              },
            ],
            reason: `Voice Master for ${after.member.user.tag}`,
          })) as VoiceChannel;

          await prisma.voiceMasterChannel.create({
            data: { guildId: internalId, channelId: channel.id, ownerId: after.member.id, userLimit: settings.defaultUserLimit || 0, permitted: [] as never },
          });
          await after.member.voice.setChannel(channel.id).catch(() => undefined);
          await safeSend(channel, {
            embeds: [
              baseEmbed({
                title: 'Your voice channel is ready',
                description: `Owner: <@${after.member.id}>\nUse the buttons below to manage it.`,
                color: COLORS.purple,
              }),
            ],
            components: voiceControls(),
          });
        } catch (error) {
          log.warn('Voice Master channel creation failed', { guildId: guild.id, error: String(error) });
        }
        return;
      }

      // ── Voice Master: cleanup emptied channel ───────────────
      const emptiedChannelId = before.channelId;
      if (emptiedChannelId && emptiedChannelId !== after.channelId) {
        const record = await prisma.voiceMasterChannel.findUnique({ where: { channelId: emptiedChannelId } }).catch(() => null);
        if (record) {
          const channel = await guild.channels.fetch(emptiedChannelId).catch(() => null);
          if (channel?.isVoiceBased() && channel.members.size === 0) {
            setTimeout(() => {
              void (async () => {
                const fresh = await guild.channels.fetch(emptiedChannelId).catch(() => null);
                if (fresh?.isVoiceBased() && fresh.members.size === 0) {
                  await fresh.delete('Temporary voice channel empty').catch(() => undefined);
                  await prisma.voiceMasterChannel.deleteMany({ where: { channelId: emptiedChannelId } }).catch(() => undefined);
                }
              })();
            }, Math.max(5, settings.deleteWhenEmptySeconds) * 1000);
          }
        }
      }
    } catch (error) {
      log.error('Voice pipeline failed', { guildId: guild.id, error: String(error) });
    }
  });

  log.info('Voice handlers registered');
}

/** Voice Master button routing (called from the interaction handler). */
export async function handleVoiceMasterButton(interaction: ButtonInteraction, _client: Client): Promise<void> {
  const guild = interaction.guild;
  if (!guild) return;
  const channel = interaction.channel;
  if (!channel?.isVoiceBased()) {
    await interaction.reply({ embeds: [errorEmbed('Voice Master', 'These controls only work inside a temporary voice channel.')], flags: 64 });
    return;
  }
  const internalId = await requireGuildId(guild.id);
  const record = await prisma.voiceMasterChannel.findUnique({ where: { channelId: channel.id } });
  const settings = await getModuleSettings<VoiceMasterSettings>(internalId, 'voicemaster');
  if (!record) {
    await interaction.reply({ embeds: [errorEmbed('Voice Master', 'This channel is not managed by Voice Master.')], flags: 64 });
    return;
  }

  const isOwner = record.ownerId === interaction.user.id;
  const action = interaction.customId.split(':')[1];

  if (!isOwner && action !== 'claim' && action !== 'kick') {
    await interaction.reply({ embeds: [errorEmbed('Not allowed', 'Only the channel owner can use these controls.')], flags: 64 });
    return;
  }

  try {
    switch (action) {
      case 'lock':
        await channel.permissionOverwrites.edit(guild.roles.everyone, { Connect: false });
        await prisma.voiceMasterChannel.update({ where: { id: record.id }, data: { locked: true } });
        await interaction.reply({ embeds: [successEmbed('Locked', 'New members cannot join.')], flags: 64 });
        break;
      case 'unlock':
        await channel.permissionOverwrites.edit(guild.roles.everyone, { Connect: true });
        await prisma.voiceMasterChannel.update({ where: { id: record.id }, data: { locked: false } });
        await interaction.reply({ embeds: [successEmbed('Unlocked', 'Members can join again.')], flags: 64 });
        break;
      case 'hide':
        await channel.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: false });
        await prisma.voiceMasterChannel.update({ where: { id: record.id }, data: { hidden: true } });
        await interaction.reply({ embeds: [successEmbed('Hidden', 'The channel is hidden.')], flags: 64 });
        break;
      case 'unhide':
        await channel.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: true });
        await prisma.voiceMasterChannel.update({ where: { id: record.id }, data: { hidden: false } });
        await interaction.reply({ embeds: [successEmbed('Revealed', 'The channel is visible.')], flags: 64 });
        break;
      case 'claim': {
        if (!settings.allowClaim) {
          await interaction.reply({ embeds: [errorEmbed('Claim disabled', 'Claiming is disabled for this server.')], flags: 64 });
          return;
        }
        const owner = await guild.members.fetch(record.ownerId).catch(() => null);
        if (owner?.voice.channelId === channel.id) {
          await interaction.reply({ embeds: [errorEmbed('Owner present', 'The owner is still in the channel.')], flags: 64 });
          return;
        }
        await prisma.voiceMasterChannel.update({ where: { id: record.id }, data: { ownerId: interaction.user.id } });
        await channel.permissionOverwrites.edit(interaction.user.id, { ManageChannels: true, MoveMembers: true });
        await interaction.reply({ embeds: [successEmbed('Claimed', `<@${interaction.user.id}> now owns this channel.`)] });
        break;
      }
      case 'kick':
        await interaction.reply({
          embeds: [baseEmbed({ title: 'Kick a member', description: 'Use `/voice kick` mentioning the member, or right-click them → Move to another channel.' })],
          flags: 64,
        });
        break;
      default:
        await interaction.reply({ embeds: [errorEmbed('Voice Master', 'Unknown control.')], flags: 64 });
    }
  } catch (error) {
    log.warn('Voice Master control failed', { action, error: String(error) });
    if (!interaction.replied) await interaction.reply({ embeds: [errorEmbed('Voice Master', 'That action failed. Check my permissions.')], flags: 64 });
  }
}
