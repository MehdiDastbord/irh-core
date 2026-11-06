/** Interaction routing: commands, buttons, select menus and modals. */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { logger, prisma, requireGuildId } from '@irh/db';
import { randomCode } from '@irh/shared';
import { registerGuild } from '../lib/settings.js';
import { baseEmbed, COLORS, errorEmbed, successEmbed } from '../lib/embed.js';
import { checkCaptcha, startVerification, verificationResult, verificationSettings } from '../modules/verification.js';
import { closeTicket, openTicket, recordFeedback, ticketControls } from '../modules/tickets.js';
import { enterGiveaway } from '../modules/giveaways.js';
import { handleVoiceMasterButton } from './voice.js';

const log = logger.child('interactions');
const knownGuilds = new Set<string>();

async function ensureGuild(interaction: { guild?: { id: string } | null; guildId?: string | null }) {
  const id = interaction.guildId;
  if (!id || knownGuilds.has(id)) return;
  const guild = 'guild' in interaction ? interaction.guild : null;
  if (!guild) return;
  await registerGuild(guild as never);
  knownGuilds.add(id);
}

async function safeError(interaction: { replied?: boolean; deferred?: boolean; reply: (options: unknown) => Promise<unknown>; followUp: (options: unknown) => Promise<unknown>; editReply: (options: unknown) => Promise<unknown> }, message: string) {
  const payload = { embeds: [errorEmbed('Something went wrong', message)], flags: MessageFlags.Ephemeral };
  try {
    if (interaction.deferred) await interaction.editReply({ embeds: [errorEmbed('Something went wrong', message)] });
    else if (interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch {
    /* interaction expired */
  }
}

export function registerInteractionHandlers(client: Client): void {
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) return await handleCommand(interaction, client);
      if (!interaction.inCachedGuild()) return;
      await ensureGuild(interaction);
      if (interaction.isButton()) return await handleButton(interaction, client);
      if (interaction.isStringSelectMenu()) return await handleSelect(interaction, client);
      if (interaction.isModalSubmit()) return await handleModal(interaction, client);
    } catch (error) {
      log.error('Interaction failed', {
        type: interaction.type,
        customId: 'customId' in interaction ? interaction.customId : undefined,
        error: String(error),
      });
      await safeError(interaction as never, 'That interaction could not be completed. Please try again.');
    }
  });
}

async function handleCommand(interaction: ChatInputCommandInteraction, client: Client): Promise<void> {
  const command = client.commands.get(interaction.commandName);
  if (!command) return;
  if (interaction.guild) await ensureGuild(interaction);
  if (command.ownerOnly) {
    const { env } = await import('../env.js');
    if (!env.ownerIds.includes(interaction.user.id)) {
      await interaction.reply({ embeds: [errorEmbed('Owner only', 'This command is restricted to bot owners.')], flags: MessageFlags.Ephemeral });
      return;
    }
  }
  const started = Date.now();
  await command.execute(interaction, client);
  log.debug('Command executed', { command: interaction.commandName, ms: Date.now() - started });
}

async function handleButton(interaction: ButtonInteraction, client: Client): Promise<void> {
  const [namespace, action, ...rest] = interaction.customId.split(':');

  if (namespace === 'vm') return handleVoiceMasterButton(interaction, client);

  if (namespace === 'verify') {
    if (action === 'entercode') {
      const modal = new ModalBuilder().setCustomId(`verify:code:${interaction.guildId}`).setTitle('Enter verification code');
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('code').setLabel('Code from the previous message').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(4).setMaxLength(8),
        ),
      );
      await interaction.showModal(modal);
      return;
    }

    const settings = await verificationSettings(interaction.guildId!);
    if (settings.mode === 'captcha') {
      const internalId = await requireGuildId(interaction.guildId!);
      const code = randomCode(Math.min(8, Math.max(4, settings.captchaLength)));
      await prisma.verificationSession.upsert({
        where: { guildId_discordId: { guildId: internalId, discordId: interaction.user.id } },
        create: { guildId: internalId, discordId: interaction.user.id, code, expiresAt: new Date(Date.now() + 600_000) },
        update: { code, status: 'pending', attempts: 0, expiresAt: new Date(Date.now() + 600_000) },
      });
      await interaction.reply({
        embeds: [baseEmbed({ title: 'Verification code', description: `Your code is **${code}**\nIt expires in 10 minutes.`, color: COLORS.info })],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId('verify:entercode').setLabel('Enter code').setStyle(ButtonStyle.Primary),
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const member = await interaction.guild!.members.fetch(interaction.user.id);
    const result = await startVerification(member);
    await interaction.reply({ embeds: [verificationResult(result.ok, result.message)], flags: MessageFlags.Ephemeral });
    return;
  }

  if (namespace === 'rr') {
    const internalId = await requireGuildId(interaction.guildId!);
    if (action === 'toggle') {
      const [panelId, roleId] = rest;
      const panel = await prisma.reactionRolePanel.findFirst({ where: { id: panelId, guildId: internalId } });
      if (!panel || !roleId) {
        await interaction.reply({ embeds: [errorEmbed('Reaction roles', 'That panel no longer exists.')], flags: MessageFlags.Ephemeral });
        return;
      }
      const member = await interaction.guild!.members.fetch(interaction.user.id);
      const role = interaction.guild!.roles.cache.get(roleId);
      if (!role) {
        await interaction.reply({ embeds: [errorEmbed('Reaction roles', 'That role no longer exists.')], flags: MessageFlags.Ephemeral });
        return;
      }
      const me = interaction.guild!.members.me;
      if (!me || me.roles.highest.position <= role.position) {
        await interaction.reply({ embeds: [errorEmbed('Reaction roles', 'My role is too low to manage that role.')], flags: MessageFlags.Ephemeral });
        return;
      }
      if (member.roles.cache.has(role.id)) {
        await member.roles.remove(role, 'Reaction role').catch(() => undefined);
        await interaction.reply({ embeds: [successEmbed('Role removed', `Removed <@&${role.id}>.`)], flags: MessageFlags.Ephemeral });
      } else {
        if (panel.unique) {
          const options = (panel.options as { roleId: string }[]) ?? [];
          const others = options.map((option) => option.roleId).filter((id) => id !== role.id && member.roles.cache.has(id));
          if (others.length) await member.roles.remove(others, 'Exclusive reaction role').catch(() => undefined);
        }
        await member.roles.add(role, 'Reaction role').catch(() => undefined);
        await interaction.reply({ embeds: [successEmbed('Role added', `You now have <@&${role.id}>.`)], flags: MessageFlags.Ephemeral });
      }
      return;
    }
  }

  if (namespace === 'ticket') {
    const internalId = await requireGuildId(interaction.guildId!);

    if (action === 'open') {
      const panelId = rest[0];
      const panel = panelId ? await prisma.ticketPanel.findFirst({ where: { id: panelId, guildId: internalId } }) : null;
      const fields = (panel?.formFields as { key: string; label: string; style: 'short' | 'paragraph'; required: boolean; maxLength: number }[]) ?? [];
      if (fields.length) {
        const modal = new ModalBuilder().setCustomId(`ticket:modal:${panelId}`).setTitle(panel?.name.slice(0, 45) ?? 'Open a ticket');
        modal.addComponents(
          ...fields.slice(0, 5).map((field) =>
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId(`field_${field.key}`.slice(0, 100))
                .setLabel(field.label.slice(0, 45))
                .setStyle(field.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
                .setRequired(field.required !== false)
                .setMaxLength(Math.min(1024, field.maxLength ?? 200)),
            ),
          ),
        );
        await interaction.showModal(modal);
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const member = await interaction.guild!.members.fetch(interaction.user.id);
      const result = await openTicket({ guild: interaction.guild!, member, panelId: panelId ?? null });
      await interaction.editReply({ embeds: [result.ok ? successEmbed('Ticket opened', result.message) : errorEmbed('Ticket', result.message)] });
      return;
    }

    if (action === 'claim') {
      const ticket = await prisma.ticket.findFirst({ where: { guildId: internalId, channelId: interaction.channelId } });
      if (!ticket) {
        await interaction.reply({ embeds: [errorEmbed('Not a ticket', 'No ticket record for this channel.')], flags: MessageFlags.Ephemeral });
        return;
      }
      await prisma.ticket.update({ where: { id: ticket.id }, data: { status: 'claimed', claimedById: interaction.user.id } });
      await interaction.update({ components: ticketControls(true) });
      await interaction.followUp({ embeds: [successEmbed('Claimed', `<@${interaction.user.id}> is handling this ticket.`)] });
      return;
    }

    if (action === 'close') {
      const ticket = await prisma.ticket.findFirst({ where: { guildId: internalId, channelId: interaction.channelId } });
      if (!ticket) {
        await interaction.reply({ embeds: [errorEmbed('Not a ticket', 'No ticket record for this channel.')], flags: MessageFlags.Ephemeral });
        return;
      }
      const settings = await prisma.guildSetting.findUnique({ where: { guildId_moduleId: { guildId: internalId, moduleId: 'tickets' } } });
      const allowMemberClose = (settings?.data as { allowMemberClose?: boolean } | null)?.allowMemberClose ?? true;
      if (!allowMemberClose && interaction.user.id !== ticket.userId && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
        await interaction.reply({ embeds: [errorEmbed('Not allowed', 'Only staff can close this ticket.')], flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.reply({ embeds: [baseEmbed({ title: 'Ticket closing', description: 'Generating transcript…', color: COLORS.muted })], flags: MessageFlags.Ephemeral });
      await closeTicket({ guild: interaction.guild!, channelId: interaction.channelId, actorId: interaction.user.id });
      return;
    }

    if (action === 'add') {
      const modal = new ModalBuilder().setCustomId('ticket:add').setTitle('Add a member');
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('user_id').setLabel('Member ID or mention').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40),
        ),
      );
      await interaction.showModal(modal);
      return;
    }

    if (action === 'rename') {
      const modal = new ModalBuilder().setCustomId('ticket:rename').setTitle('Rename ticket');
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId('name').setLabel('New channel name').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80),
        ),
      );
      await interaction.showModal(modal);
      return;
    }

    if (action === 'rate') {
      const [ticketId, rating] = rest;
      if (!ticketId || !rating) return;
      await recordFeedback(ticketId, Number(rating), interaction.user.id);
      await interaction.reply({ embeds: [successEmbed('Thank you', `You rated this ticket ${rating}/5.`)], flags: MessageFlags.Ephemeral });
      return;
    }
  }

  if (namespace === 'gw') {
    const giveawayId = rest[0];
    if (!giveawayId) return;
    if (action === 'enter') {
      if (!interaction.guild) return;
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const result = await enterGiveaway(giveawayId, {
        id: member.id,
        roles: { cache: member.roles.cache },
        user: { bot: member.user.bot, createdAt: member.user.createdAt },
        joinedAt: member.joinedAt,
      });
      await interaction.reply({ embeds: [result.ok ? successEmbed('Entered', result.message) : errorEmbed('Not entered', result.message)], flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === 'participants') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({ embeds: [errorEmbed('Not allowed', 'Only staff can view entries.')], flags: MessageFlags.Ephemeral });
        return;
      }
      const entries = await prisma.giveawayEntry.findMany({ where: { giveawayId }, take: 30, orderBy: { createdAt: 'desc' } });
      await interaction.reply({
        embeds: [
          baseEmbed({
            title: 'Giveaway entries',
            description: entries.length ? entries.map((entry) => `<@${entry.discordId}>${entry.bonusEntries > 1 ? ` (${entry.bonusEntries}x)` : ''}`).join('\n') : 'No entries yet.',
          }),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }
  }

}

async function handleSelect(interaction: StringSelectMenuInteraction, _client: Client): Promise<void> {
  const [namespace, action, panelId] = interaction.customId.split(':');
  if (namespace !== 'rr' || action !== 'select' || !panelId) return;
  const internalId = await requireGuildId(interaction.guildId!);
  const panel = await prisma.reactionRolePanel.findFirst({ where: { id: panelId, guildId: internalId } });
  if (!panel) {
    await interaction.reply({ embeds: [errorEmbed('Reaction roles', 'Panel not found.')], flags: MessageFlags.Ephemeral });
    return;
  }
  const options = (panel.options as { roleId: string }[]) ?? [];
  const selected = interaction.values;
  const member = await interaction.guild!.members.fetch(interaction.user.id);
  const me = interaction.guild!.members.me;
  const manageable = options.filter((option) => {
    const role = interaction.guild!.roles.cache.get(option.roleId);
    return role && me && me.roles.highest.position > role.position;
  });
  const toAdd = manageable.filter((option) => selected.includes(option.roleId) && !member.roles.cache.has(option.roleId));
  const toRemove = manageable.filter((option) => !selected.includes(option.roleId) && member.roles.cache.has(option.roleId));
  if (toAdd.length) await member.roles.add(toAdd.map((option) => option.roleId), 'Reaction roles').catch(() => undefined);
  if (toRemove.length) await member.roles.remove(toRemove.map((option) => option.roleId), 'Reaction roles').catch(() => undefined);
  await interaction.reply({ embeds: [successEmbed('Roles updated', 'Your roles have been updated.')], flags: MessageFlags.Ephemeral });
}

async function handleModal(interaction: ModalSubmitInteraction, _client: Client): Promise<void> {
  const [namespace, action, ...rest] = interaction.customId.split(':');

  if (namespace === 'verify' && action === 'code') {
    const member = await interaction.guild!.members.fetch(interaction.user.id);
    const result = await checkCaptcha(member, interaction.fields.getTextInputValue('code'));
    await interaction.reply({ embeds: [verificationResult(result.ok, result.message)], flags: MessageFlags.Ephemeral });
    return;
  }

  if (namespace === 'ticket' && action === 'modal') {
    const panelId = rest[0];
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const internalId = await requireGuildId(interaction.guildId!);
    const panel = panelId ? await prisma.ticketPanel.findFirst({ where: { id: panelId, guildId: internalId } }) : null;
    const fields = (panel?.formFields as { key: string; label: string }[]) ?? [];
    const formData: Record<string, string> = {};
    for (const field of fields) {
      try {
        formData[field.label] = interaction.fields.getTextInputValue(`field_${field.key}`.slice(0, 100));
      } catch {
        /* optional field left empty */
      }
    }
    const member = await interaction.guild!.members.fetch(interaction.user.id);
    const result = await openTicket({
      guild: interaction.guild!,
      member,
      panelId: panelId ?? null,
      subject: panel?.name ?? 'Support request',
      formData,
    });
    await interaction.editReply({ embeds: [result.ok ? successEmbed('Ticket opened', result.message) : errorEmbed('Ticket', result.message)] });
    return;
  }

  if (namespace === 'ticket' && action === 'add') {
    const raw = interaction.fields.getTextInputValue('user_id').replace(/[<@!>]/g, '').trim();
    if (!/^\d{15,25}$/.test(raw)) {
      await interaction.reply({ embeds: [errorEmbed('Invalid member', 'Provide a valid member ID or mention.')], flags: MessageFlags.Ephemeral });
      return;
    }
    const channel = interaction.channel;
    if (!channel || !('permissionOverwrites' in channel)) return;
    await channel.permissionOverwrites.edit(raw, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
    await interaction.reply({ embeds: [successEmbed('Member added', `<@${raw}> can now see this ticket.`)] });
    return;
  }

  if (namespace === 'ticket' && action === 'rename') {
    const name = interaction.fields.getTextInputValue('name').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 90);
    const channel = interaction.channel;
    if (!channel || !('setName' in channel)) return;
    await channel.setName(name, `Renamed by ${interaction.user.tag}`).catch(() => undefined);
    await interaction.reply({ embeds: [successEmbed('Renamed', `This ticket is now **${name}**.`)] });
    return;
  }

}
