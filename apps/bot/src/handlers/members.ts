/** Member lifecycle: autoroles, verification gate, welcome, invites, alt detection. */

import { AuditLogEvent, Events, type Client, type GuildMember, type PartialGuildMember } from 'discord.js';
import { getModuleSettings, logger, prisma, requireGuildId } from '@irh/db';
import { registerGuild, invalidateSettings } from '../lib/settings.js';
import { emitLog, correlateExecutor } from '../lib/logging.js';
import { sendGoodbye, sendWelcome } from '../modules/welcome.js';
import { attributeJoin, attributeLeave } from '../modules/invites.js';
import { detectAlt, detectRaid } from '../modules/security.js';
import { runWorkflows } from '../modules/automations.js';
import { verificationSettings } from '../modules/verification.js';

const log = logger.child('members');

export async function grantJoinRoles(member: GuildMember, internalId: string): Promise<void> {
  const settings = await getModuleSettings<{
    enabled: boolean;
    roleIds: string[];
    botRoleIds: string[];
    delaySeconds: number;
    restoreOnRejoin: boolean;
  }>(internalId, 'autoroles');
  if (!settings.enabled) return;
  const wanted = [...(member.user.bot ? settings.botRoleIds ?? [] : settings.roleIds ?? [])];
  if (settings.restoreOnRejoin) {
    const previous = await prisma.auditRecord.findFirst({
      where: { guildId: internalId, action: 'member.roles_snapshot', targetId: member.id },
      orderBy: { createdAt: 'desc' },
    });
    const roles = (previous?.after as { roles?: string[] } | null)?.roles ?? [];
    wanted.push(...roles.filter((roleId) => !member.roles.cache.has(roleId)));
  }
  const roles = member.guild.roles.cache.filter((role) => wanted.includes(role.id) && !role.managed && role.position < (member.guild.members.me?.roles.highest.position ?? 0));
  if (!roles.size) return;
  if (settings.delaySeconds) await new Promise((resolve) => setTimeout(resolve, settings.delaySeconds * 1000));
  await member.roles.add(roles, 'Autorole').catch((error) => log.warn('Autorole failed', { guildId: member.guild.id, error: String(error) }));
}

export function registerMemberHandlers(client: Client): void {
  client.on(Events.GuildMemberAdd, async (member) => {
    try {
      const internalId = await registerGuild(member.guild);
      await detectRaid(member.guild).catch(() => null);
      const alt = await detectAlt(member.guild, member).catch(() => false);

      await prisma.guildMember
        .upsert({
          where: { guildId_discordId: { guildId: internalId, discordId: member.id } },
          create: {
            guildId: internalId,
            discordId: member.id,
            username: member.user.tag,
            joinedAt: new Date(),
            accountCreatedAt: member.user.createdAt,
            isBot: member.user.bot,
          },
          update: { leftAt: null, joinedAt: new Date(), username: member.user.tag },
        })
        .catch(() => undefined);

      if (alt) return;

      const tracking = await getModuleSettings<{ enabled: boolean }>(internalId, 'invites');
      let inviter: string | null = null;
      let invites = 0;
      if (tracking.enabled && !member.user.bot) {
        const attribution = await attributeJoin(member.guild, member).catch(() => null);
        inviter = attribution?.inviterId ?? null;
        invites = inviter ? await prisma.inviteEvent.count({ where: { guildId: internalId, inviterId: inviter, type: 'join', fake: false } }) : 0;
      }

      const verification = await verificationSettings(member.guild.id).catch(() => null);
      if (verification?.enabled && verification.unverifiedRoleId) {
        await member.roles.add(verification.unverifiedRoleId, 'Verification pending').catch(() => undefined);
      }
      await grantJoinRoles(member, internalId);
      await sendWelcome(member, { inviter, invites }).catch((error) => log.warn('Welcome failed', { error: String(error) }));

      if (verification?.enabled && verification.channelId) {
        const channel = await member.guild.channels.fetch(verification.channelId).catch(() => null);
        if (channel && channel.isTextBased() && 'send' in channel) {
          await member
            .send({ content: `Please verify in <#${verification.channelId}> to access **${member.guild.name}**.` })
            .catch(() => undefined);
          void channel;
        }
      }

      await prisma.statSnapshot
        .upsert({
          where: { guildId_date: { guildId: internalId, date: new Date().toISOString().slice(0, 10) } },
          create: { guildId: internalId, date: new Date().toISOString().slice(0, 10), joins: 1, inviteJoins: inviter ? 1 : 0, memberCount: member.guild.memberCount },
          update: { joins: { increment: 1 }, inviteJoins: { increment: inviter ? 1 : 0 }, memberCount: member.guild.memberCount },
        })
        .catch(() => undefined);

      await emitLog({
        guild: member.guild,
        event: 'member.join',
        summary: `${member.user.tag} joined the server`,
        targetId: member.id,
        fields: [
          { name: 'Account created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
          ...(inviter ? [{ name: 'Inviter', value: `<@${inviter}> (${invites} invites)`, inline: true }] : []),
          { name: 'Member count', value: String(member.guild.memberCount), inline: true },
        ],
      });

      await runWorkflows('member.join', { guild: member.guild, member }).catch(() => 0);
    } catch (error) {
      log.error('Join pipeline failed', { guildId: member.guild.id, error: String(error) });
    }
  });

  client.on(Events.GuildMemberRemove, async (member) => {
    try {
      const internalId = await requireGuildId(member.guild.id);
      await sendGoodbye(member as GuildMember).catch(() => undefined);
      const tracking = await getModuleSettings<{ enabled: boolean; trackLeaves: boolean }>(internalId, 'invites');
      if (tracking.enabled && tracking.trackLeaves) await attributeLeave(member.guild, member as GuildMember).catch(() => undefined);
      const roles = [...(member.roles?.cache.keys() ?? [])].filter((roleId) => roleId !== member.guild.id);
      await prisma.auditRecord
        .create({ data: { guildId: internalId, action: 'member.roles_snapshot', actorType: 'system', targetType: 'member', targetId: member.id, after: { roles } as never } })
        .catch(() => undefined);
      await emitLog({
        guild: member.guild,
        event: 'member.leave',
        summary: `${member.user.tag} left the server`,
        targetId: member.id,
        fields: [{ name: 'Member count', value: String(member.guild.memberCount), inline: true }],
      });
      await runWorkflows('member.leave', { guild: member.guild, member: member as GuildMember }).catch(() => 0);
    } catch (error) {
      log.error('Leave pipeline failed', { error: String(error) });
    }
  });

  client.on(Events.GuildMemberUpdate, async (before: GuildMember | PartialGuildMember, after: GuildMember) => {
    try {
      const added = after.roles.cache.filter((role) => !before.roles?.cache.has(role.id));
      const removed = before.roles?.cache.filter((role) => !after.roles.cache.has(role.id));
      if (added.size) {
        await emitLog({
          guild: after.guild,
          event: 'member.rolesUpdate',
          summary: `Roles added to ${after.user.tag}: ${added.map((role) => `<@&${role.id}>`).join(', ')}`,
          targetId: after.id,
          executorId: after.guild.members.me?.permissions.has('ViewAuditLog')
            ? await correlateExecutor(after.guild, AuditLogEvent.MemberRoleUpdate, after.id)
            : null,
        });
      }
      if (removed?.size) {
        await emitLog({
          guild: after.guild,
          event: 'member.rolesUpdate',
          summary: `Roles removed from ${after.user.tag}: ${removed.map((role) => `<@&${role.id}>`).join(', ')}`,
          targetId: after.id,
          executorId: after.guild.members.me?.permissions.has('ViewAuditLog')
            ? await correlateExecutor(after.guild, AuditLogEvent.MemberRoleUpdate, after.id)
            : null,
        });
      }
      if (before.nickname !== after.nickname) {
        await emitLog({
          guild: after.guild,
          event: 'member.nickname',
          summary: `Nickname changed for ${after.user.tag}`,
          targetId: after.id,
          fields: [
            { name: 'Before', value: before.nickname ?? '—', inline: true },
            { name: 'After', value: after.nickname ?? '—', inline: true },
          ],
        });
      }
      if (before.premiumSinceTimestamp !== after.premiumSinceTimestamp) {
        const boosting = !before.premiumSince && Boolean(after.premiumSince);
        await emitLog({
          guild: after.guild,
          event: boosting ? 'member.boost' : 'member.unboost',
          summary: `${after.user.tag} ${boosting ? 'started boosting' : 'stopped boosting'}`,
          targetId: after.id,
          color: 0xf47fff,
        });
      }

      const sticky = await getModuleSettings<{ stickyRoles: boolean }>(await requireGuildId(after.guild.id), 'autoroles');
      if (sticky.stickyRoles && removed?.size) {
        const keeper = removed.filter((role) => !role.managed && role.id !== after.guild.id);
        if (keeper.size) await after.roles.add(keeper, 'Sticky roles').catch(() => undefined);
      }
      invalidateSettings(after.guild.id);
    } catch (error) {
      log.warn('Member update pipeline failed', { error: String(error) });
    }
  });

  client.on(Events.UserUpdate, async (before, after) => {
    if (before.avatar === after.avatar && before.username === after.username) return;
    for (const guild of client.guilds.cache.values()) {
      const member = guild.members.cache.get(after.id);
      if (!member) continue;
      await emitLog({
        guild,
        event: 'member.avatar',
        summary: `${after.tag} updated their profile`,
        targetId: after.id,
        fields: [{ name: 'Changes', value: before.username !== after.username ? `username: ${before.username} → ${after.username}` : 'avatar changed' }],
      }).catch(() => undefined);
    }
  });

  client.on(Events.GuildMemberAvailable, () => undefined);

  log.info('Member handlers registered');
}
