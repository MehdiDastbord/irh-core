/** Invite tracking: cache diffing, attribution and milestone rewards. */

import type { Guild, GuildMember, Invite } from 'discord.js';
import { getModuleSettings, logger, prisma, requireGuildId } from '@irh/db';
import { emitLog } from '../lib/logging.js';

const log = logger.child('invites');

const cache = new Map<string, Map<string, number>>();

export async function refreshInviteCache(guild: Guild): Promise<void> {
  try {
    const invites = await guild.invites.fetch();
    cache.set(guild.id, new Map(invites.map((invite) => [invite.code, invite.uses ?? 0])));
    for (const invite of invites.values()) {
      if (!invite.inviter) continue;
      await prisma.invite
        .upsert({
          where: { guildId_code: { guildId: await requireGuildId(guild.id), code: invite.code } },
          create: {
            guildId: await requireGuildId(guild.id),
            code: invite.code,
            inviterId: invite.inviter.id,
            uses: invite.uses ?? 0,
            maxUses: invite.maxUses,
            maxAge: invite.maxAge,
            temporary: invite.temporary ?? false,
            channelId: invite.channelId,
          },
          update: { uses: invite.uses ?? 0, lastUsedAt: new Date() },
        })
        .catch(() => undefined);
    }
  } catch (error) {
    log.debug('Invite cache unavailable', { guildId: guild.id, error: String(error) });
  }
}

/** Determine which invite was used by diffing the cache. */
export async function attributeJoin(guild: Guild, member: GuildMember): Promise<{ inviterId: string | null; code: string | null; fake: boolean }> {
  const previous = cache.get(guild.id);
  let invites: Awaited<ReturnType<typeof guild.invites.fetch>>;
  try {
    invites = await guild.invites.fetch();
  } catch {
    return { inviterId: null, code: null, fake: false };
  }

  let used: Invite | null = null;
  for (const invite of invites.values()) {
    const before = previous?.get(invite.code) ?? 0;
    if ((invite.uses ?? 0) > before) {
      used = invite;
      break;
    }
  }
  cache.set(guild.id, new Map(invites.map((invite) => [invite.code, invite.uses ?? 0])));

  if (!used?.inviter) return { inviterId: null, code: used?.code ?? null, fake: false };

  const settings = await getModuleSettings<{ fakeAccountAgeDays: number; logChannelId: string | null; rewards: { invites: number; roleId: string }[] }>(
    await requireGuildId(guild.id),
    'invites',
  );
  const ageDays = (Date.now() - member.user.createdTimestamp) / 86_400_000;
  const fake = ageDays < (settings.fakeAccountAgeDays ?? 3);

  await prisma.inviteEvent.create({
    data: {
      guildId: await requireGuildId(guild.id),
      code: used.code,
      inviterId: used.inviter.id,
      inviteeId: member.id,
      type: 'join',
      fake,
    },
  });
  await prisma.guildMember
    .upsert({
      where: { guildId_discordId: { guildId: await requireGuildId(guild.id), discordId: member.id } },
      create: {
        guildId: await requireGuildId(guild.id),
        discordId: member.id,
        username: member.user.tag,
        joinedAt: new Date(),
        inviteCode: used.code,
        invitedById: used.inviter.id,
        accountCreatedAt: member.user.createdAt,
        isBot: member.user.bot,
      },
      update: { joinedAt: new Date(), leftAt: null, inviteCode: used.code, invitedById: used.inviter.id, accountCreatedAt: member.user.createdAt },
    })
    .catch(() => undefined);

  if (!fake && settings.rewards?.length) {
    const valid = await prisma.inviteEvent.count({ where: { guildId: await requireGuildId(guild.id), inviterId: used.inviter.id, type: 'join', fake: false } });
    for (const reward of settings.rewards) {
      if (valid < reward.invites) continue;
      const inviter = await guild.members.fetch(used.inviter.id).catch(() => null);
      if (inviter?.roles.cache.has(reward.roleId)) continue;
      await inviter?.roles.add(reward.roleId, `Invite milestone: ${reward.invites}`).catch(() => undefined);
    }
  }

  await emitLog({
    guild,
    event: 'invite.track',
    summary: `${member.user.tag} joined via \`${used.code}\`${fake ? ' (flagged as fake)' : ''}`,
    executorId: used.inviter.id,
    targetId: member.id,
    fields: [
      { name: 'Inviter', value: `<@${used.inviter.id}>`, inline: true },
      { name: 'Code', value: used.code, inline: true },
      { name: 'Fake', value: fake ? 'Yes' : 'No', inline: true },
    ],
  });

  return { inviterId: used.inviter.id, code: used.code, fake };
}

export async function attributeLeave(guild: Guild, member: GuildMember): Promise<void> {
  const internalId = await requireGuildId(guild.id);
  const record = await prisma.guildMember.findUnique({ where: { guildId_discordId: { guildId: internalId, discordId: member.id } } });
  await prisma.guildMember
    .updateMany({ where: { guildId: internalId, discordId: member.id }, data: { leftAt: new Date() } })
    .catch(() => undefined);
  if (record?.invitedById) {
    await prisma.inviteEvent.create({
      data: { guildId: internalId, code: record.inviteCode, inviterId: record.invitedById, inviteeId: member.id, type: 'leave' },
    });
  }
}

export async function inviteLeaderboard(guildId: string, limit = 10) {
  const internalId = await requireGuildId(guildId);
  const rows = await prisma.inviteEvent.groupBy({
    by: ['inviterId'],
    where: { guildId: internalId, type: 'join', fake: false },
    _count: { _all: true },
    orderBy: { _count: { inviterId: 'desc' } },
    take: limit,
  });
  return rows.map((row) => ({ inviterId: row.inviterId ?? 'unknown', joins: row._count._all }));
}

export async function inviterFor(guildId: string, memberId: string): Promise<{ inviterId: string | null; joins: number }> {
  const internalId = await requireGuildId(guildId);
  const record = await prisma.guildMember.findUnique({ where: { guildId_discordId: { guildId: internalId, discordId: memberId } } });
  const inviterId = record?.invitedById ?? null;
  if (!inviterId) return { inviterId: null, joins: 0 };
  const joins = await prisma.inviteEvent.count({ where: { guildId: internalId, inviterId, type: 'join', fake: false } });
  return { inviterId, joins };
}

export function clearInviteCache(guildId?: string): void {
  if (guildId) cache.delete(guildId);
  else cache.clear();
}
