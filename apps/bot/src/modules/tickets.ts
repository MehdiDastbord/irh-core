/** Ticket lifecycle: create, claim, close, transcript, feedback. */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type TextChannel,
  type Interaction,
  type ButtonInteraction,
} from 'discord.js';
import {
  buildTranscript,
  closeTicketRecord,
  createTicket,
  findTicketByChannel,
  getModuleSettings,
  logger,
  openTicketCount,
  prisma,
  recordTicketMessage,
  requireGuildId,
  saveTranscript,
  ticketNaming,
} from '@irh/db';
import { baseEmbed, COLORS, errorEmbed, successEmbed } from '../lib/embed.js';
import { emitLog } from '../lib/logging.js';
import { safeDm } from '../lib/discord-utils.js';

const log = logger.child('tickets');

export interface TicketSettings {
  enabled: boolean;
  categoryId: string | null;
  transcriptChannelId: string | null;
  supportRoleIds: string[];
  maxOpenPerUser: number;
  inactiveCloseHours: number;
  dmOnOpen: boolean;
  ratingEnabled: boolean;
  allowMemberClose: boolean;
  namingTemplate: string;
}

export async function ticketSettings(guildId: string): Promise<TicketSettings> {
  return getModuleSettings<TicketSettings>(await requireGuildId(guildId), 'tickets');
}

export function ticketControls(claimed = false) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('ticket:claim').setLabel(claimed ? 'Claimed' : 'Claim').setStyle(ButtonStyle.Primary).setDisabled(claimed).setEmoji('🙋'),
      new ButtonBuilder().setCustomId('ticket:close').setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
      new ButtonBuilder().setCustomId('ticket:add').setLabel('Add member').setStyle(ButtonStyle.Secondary).setEmoji('➕'),
      new ButtonBuilder().setCustomId('ticket:rename').setLabel('Rename').setStyle(ButtonStyle.Secondary).setEmoji('✏️'),
    ),
  ];
}

export async function openTicket(input: {
  guild: Guild;
  member: GuildMember;
  panelId?: string | null;
  subject?: string;
  formData?: Record<string, string> | null;
}): Promise<{ ok: boolean; message: string; channelId?: string }> {
  const settings = await ticketSettings(input.guild.id);
  if (!settings.enabled) return { ok: false, message: 'Tickets are disabled for this server.' };

  const internalId = await requireGuildId(input.guild.id);
  const panel = input.panelId ? await prisma.ticketPanel.findFirst({ where: { id: input.panelId, guildId: internalId } }) : null;
  const existing = await openTicketCount(internalId, input.member.id);
  if (existing >= (settings.maxOpenPerUser ?? 1)) {
    return { ok: false, message: `You already have ${existing} open ticket(s). Close them before opening another.` };
  }

  const number = (await prisma.ticket.aggregate({ where: { guildId: internalId }, _max: { number: true } }))._max.number ?? 0;
  const name = ticketNaming(settings.namingTemplate || 'ticket-{number}', {
    number: number + 1,
    username: input.member.user.username,
    panel: panel?.name ?? 'support',
  });

  const supportRoles = new Set<string>([...(settings.supportRoleIds ?? []), ...(((panel?.supportRoleIds as string[]) ?? []))]);
  const overwrites = [
    { id: input.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: input.member.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles],
    },
    {
      id: input.guild.members.me!.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
      ],
    },
    ...[...supportRoles].filter(Boolean).map((roleId) => ({
      id: roleId,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
    })),
  ];

  let channel: TextChannel;
  try {
    channel = (await input.guild.channels.create({
      name,
      type: ChannelType.GuildText,
      ...(settings.categoryId ? { parent: settings.categoryId } : panel?.categoryId ? { parent: String(panel.categoryId) } : {}),
      permissionOverwrites: overwrites,
      topic: `Ticket for ${input.member.user.tag} (${input.member.id})`,
    })) as TextChannel;
  } catch (error) {
    log.warn('Ticket channel creation failed', { guildId: input.guild.id, error: String(error) });
    return { ok: false, message: 'I could not create the ticket channel. Check my Manage Channels permission.' };
  }

  const ticket = await createTicket({
    guildId: internalId,
    channelId: channel.id,
    userId: input.member.id,
    username: input.member.user.tag,
    subject: input.subject ?? panel?.name ?? 'Support request',
    panelId: panel?.id ?? null,
    priority: panel?.defaultPriority ?? 'normal',
    formData: input.formData ?? null,
    assignedToIds: [...supportRoles],
  });

  const formLines = input.formData
    ? Object.entries(input.formData)
        .map(([key, value]) => `**${key}:** ${value.slice(0, 500)}`)
        .join('\n')
    : '';
  await channel
    .send({
      content: [...supportRoles].filter(Boolean).map((roleId) => `<@&${roleId}>`).join(' '),
      embeds: [
        baseEmbed({
          title: `Ticket #${ticket.number} — ${ticket.subject}`,
          description: `Hello <@${input.member.id}>, support will be with you shortly.\n${panel?.openMessage ?? ''}\n${formLines}`,
          color: COLORS.brand,
        }),
      ],
      components: ticketControls(false),
      allowedMentions: { roles: [...supportRoles] },
    })
    .catch(() => undefined);

  if (settings.dmOnOpen) {
    await safeDm(input.member, `Your ticket **#${ticket.number}** has been opened in **${input.guild.name}**.`);
  }

  await recordTicketMessage(ticket.id, {
    authorId: 'system',
    authorTag: 'IRH CORE',
    content: `Ticket #${ticket.number} opened by ${input.member.user.tag}.`,
  });

  await emitLog({
    guild: input.guild,
    event: 'ticket.create',
    summary: `Ticket #${ticket.number} opened by ${input.member.user.tag}`,
    executorId: input.member.id,
    targetId: channel.id,
    channelId: channel.id,
    bypassIgnore: true,
  });
  await prisma.statSnapshot
    .upsert({
      where: { guildId_date: { guildId: internalId, date: new Date().toISOString().slice(0, 10) } },
      create: { guildId: internalId, date: new Date().toISOString().slice(0, 10), ticketsOpened: 1 },
      update: { ticketsOpened: { increment: 1 } },
    })
    .catch(() => undefined);

  return { ok: true, message: `Ticket created: <#${channel.id}>`, channelId: channel.id };
}

export async function closeTicket(input: {
  guild: Guild;
  channelId: string;
  actorId: string;
  reason?: string;
  requestFeedback?: boolean;
}): Promise<{ ok: boolean; message: string; transcript?: string }> {
  const ticket = await findTicketByChannel(input.channelId);
  if (!ticket) return { ok: false, message: 'This channel is not a ticket.' };
  if (ticket.status === 'closed') return { ok: false, message: 'This ticket is already closed.' };
  const settings = await ticketSettings(input.guild.id);

  const messages = await prisma.ticketMessage.findMany({ where: { ticketId: ticket.id }, orderBy: { createdAt: 'asc' }, take: 1000 });
  const content = messages.map((message) => ({
    authorId: message.authorId,
    authorTag: message.authorTag ?? message.authorId,
    content: message.content,
    createdAt: message.createdAt,
    attachments: (message.attachments as string[]) ?? [],
  }));

  const html = buildTranscript({
    guildName: input.guild.name,
    ticketNumber: ticket.number,
    subject: ticket.subject,
    openedBy: ticket.username ?? ticket.userId,
    closedBy: input.actorId,
    messages: content,
  });
  await saveTranscript({ ticketId: ticket.id, guildId: ticket.guildId, html, messageCount: content.length, createdById: input.actorId });
  await closeTicketRecord({ ticketId: ticket.id, closedById: input.actorId, reason: input.reason ?? null });

  if (settings.transcriptChannelId) {
    const channel = await input.guild.channels.fetch(settings.transcriptChannelId).catch(() => null);
    if (channel && channel.isTextBased() && 'send' in channel) {
      const { AttachmentBuilder } = await import('discord.js');
      await channel
        .send({
          embeds: [
            baseEmbed({
              title: `Ticket #${ticket.number} closed`,
              description: `**Opened by:** <@${ticket.userId}>\n**Closed by:** <@${input.actorId}>\n**Messages:** ${content.length}\n**Reason:** ${input.reason ?? '—'}`,
              color: COLORS.muted,
            }),
          ],
          files: [new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: `ticket-${ticket.number}.html` })],
        })
        .catch((error) => log.warn('Transcript delivery failed', { error: String(error) }));
    }
  }

  await emitLog({
    guild: input.guild,
    event: 'ticket.close',
    summary: `Ticket #${ticket.number} closed by <@${input.actorId}>${input.reason ? ` — ${input.reason}` : ''}`,
    executorId: input.actorId,
    channelId: input.channelId,
    bypassIgnore: true,
  });
  await prisma.statSnapshot
    .upsert({
      where: { guildId_date: { guildId: ticket.guildId, date: new Date().toISOString().slice(0, 10) } },
      create: { guildId: ticket.guildId, date: new Date().toISOString().slice(0, 10), ticketsClosed: 1 },
      update: { ticketsClosed: { increment: 1 } },
    })
    .catch(() => undefined);

  if (settings.ratingEnabled) {
    const member = await input.guild.members.fetch(ticket.userId).catch(() => null);
    if (member) {
      const ratingRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...[1, 2, 3, 4, 5].map((value) =>
          new ButtonBuilder()
            .setCustomId(`ticket:rate:${ticket.id}:${value}`)
            .setLabel(String(value))
            .setStyle(value >= 4 ? ButtonStyle.Success : value >= 3 ? ButtonStyle.Secondary : ButtonStyle.Danger)
            .setEmoji('⭐'),
        ),
      );
      await safeDm(member, {
        content: `Your ticket **#${ticket.number}** in **${input.guild.name}** was closed. How did we do?`,
        components: [ratingRow],
      });
    }
  }

  const channel = await input.guild.channels.fetch(input.channelId).catch(() => null);
  if (channel && 'delete' in channel) {
    await channel.delete(`Ticket closed by ${input.actorId}`).catch(() => undefined);
  }
  return { ok: true, message: 'Ticket closed.', transcript: html };
}

export async function claimTicket(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.guildId) return;
  const ticket = await findTicketByChannel(interaction.channelId);
  if (!ticket) {
    await interaction.reply({ embeds: [errorEmbed('Not a ticket', 'This channel has no ticket record.')], flags: 64 });
    return;
  }
  const settings = await ticketSettings(interaction.guildId);
  const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  const isSupport =
    member?.permissions.has(PermissionFlagsBits.ManageChannels) ||
    settings.supportRoleIds.some((roleId) => member?.roles.cache.has(roleId)) ||
    interaction.user.id === ticket.userId;
  if (!isSupport) {
    await interaction.reply({ embeds: [errorEmbed('Not allowed', 'Only support staff can claim tickets.')], flags: 64 });
    return;
  }
  await prisma.ticket.update({ where: { id: ticket.id }, data: { status: 'claimed', claimedById: interaction.user.id } });
  await interaction.update({ components: ticketControls(true) });
  await interaction.followUp({ embeds: [successEmbed('Claimed', `<@${interaction.user.id}> is handling this ticket.`)] });
  await emitLog({
    guild: interaction.guild!,
    event: 'ticket.claim',
    summary: `Ticket #${ticket.number} claimed by ${interaction.user.tag}`,
    executorId: interaction.user.id,
    channelId: interaction.channelId,
    bypassIgnore: true,
  });
}

export async function recordFeedback(ticketId: string, rating: number, userId: string): Promise<void> {
  await prisma.ticket.updateMany({ where: { id: ticketId }, data: { rating: Math.min(5, Math.max(1, rating)), feedback: null } });
  await prisma.auditRecord.create({
    data: { action: 'ticket.feedback', actorId: userId, actorType: 'user', targetType: 'ticket', targetId: ticketId, after: { rating } as never },
  });
}

export async function ticketStatsFor(guildId: string) {
  const internalId = await requireGuildId(guildId);
  const [open, closed, avg] = await Promise.all([
    prisma.ticket.count({ where: { guildId: internalId, status: { in: ['open', 'claimed'] } } }),
    prisma.ticket.count({ where: { guildId: internalId, status: 'closed' } }),
    prisma.ticket.aggregate({ where: { guildId: internalId, rating: { not: null } }, _avg: { rating: true } }),
  ]);
  return { open, closed, averageRating: avg._avg.rating ?? null };
}

export function notTicket(interaction: Interaction): string {
  return `No ticket found for channel ${interaction.channelId}`;
}

export function ticketClosedEmbed(reason?: string | null) {
  return baseEmbed({ title: 'Ticket closed', description: reason ?? 'Closing this channel…', color: COLORS.muted });
}
