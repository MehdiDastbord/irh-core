/** Verification: button, captcha and rules acceptance. */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type GuildMember } from 'discord.js';
import { getModuleSettings, logger, prisma, requireGuildId } from '@irh/db';
import { randomCode } from '@irh/shared';
import { successEmbed, errorEmbed } from '../lib/embed.js';
import { emitLog } from '../lib/logging.js';

const log = logger.child('verification');

export interface VerificationSettings {
  enabled: boolean;
  mode: 'button' | 'captcha' | 'rules';
  verifiedRoleId: string | null;
  unverifiedRoleId: string | null;
  channelId: string | null;
  message: string;
  minAccountAgeDays: number;
  captchaLength: number;
  rulesText: string;
  logChannelId: string | null;
}

export async function verificationSettings(guildId: string): Promise<VerificationSettings> {
  return getModuleSettings<VerificationSettings>(await requireGuildId(guildId), 'verification');
}

export async function hasRequiredAccountAge(member: GuildMember, settings: VerificationSettings): Promise<boolean> {
  if (!settings.minAccountAgeDays) return true;
  const ageDays = (Date.now() - member.user.createdTimestamp) / 86_400_000;
  return ageDays >= settings.minAccountAgeDays;
}

export function verificationComponents(guildId: string, mode: VerificationSettings['mode']) {
  const button = new ButtonBuilder()
    .setCustomId(mode === 'captcha' ? `verify:captcha:${guildId}` : `verify:start:${guildId}`)
    .setLabel(mode === 'rules' ? 'I accept the rules' : 'Verify')
    .setStyle(mode === 'rules' ? ButtonStyle.Success : ButtonStyle.Primary);
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(button)];
}

export async function startVerification(member: GuildMember): Promise<{ ok: boolean; message: string }> {
  const settings = await verificationSettings(member.guild.id);
  if (!settings.enabled) return { ok: false, message: 'Verification is disabled.' };
  if (!(await hasRequiredAccountAge(member, settings))) {
    return {
      ok: false,
      message: `Your account must be at least **${settings.minAccountAgeDays} days** old to verify here.`,
    };
  }

  if (settings.mode === 'captcha') {
    const internalId = await requireGuildId(member.guild.id);
    const code = randomCode(Math.min(8, Math.max(4, settings.captchaLength)));
    await prisma.verificationSession.upsert({
      where: { guildId_discordId: { guildId: internalId, discordId: member.id } },
      create: { guildId: internalId, discordId: member.id, code, expiresAt: new Date(Date.now() + 600_000) },
      update: { code, status: 'pending', attempts: 0, expiresAt: new Date(Date.now() + 600_000) },
    });
    return { ok: false, captcha: true, message: code } as unknown as { ok: boolean; message: string };
  }

  return grantVerifiedRole(member, settings);
}

export async function grantVerifiedRole(member: GuildMember, settings?: VerificationSettings): Promise<{ ok: boolean; message: string }> {
  const config = settings ?? (await verificationSettings(member.guild.id));
  if (!config.verifiedRoleId) return { ok: false, message: 'Verification role is not configured. Ask an administrator.' };
  const role = member.guild.roles.cache.get(config.verifiedRoleId);
  if (!role) return { ok: false, message: 'The verified role no longer exists.' };
  const me = member.guild.members.me;
  if (!me || me.roles.highest.position <= role.position) return { ok: false, message: 'My role is below the verification role, so I cannot assign it.' };

  try {
    await member.roles.add(role, 'Verification passed');
    if (config.unverifiedRoleId) await member.roles.remove(config.unverifiedRoleId, 'Verification passed').catch(() => undefined);
  } catch (error) {
    log.warn('Failed to grant verified role', { guildId: member.guild.id, error: String(error) });
    return { ok: false, message: 'I could not assign the verified role. Check my permissions.' };
  }

  const internalId = await requireGuildId(member.guild.id);
  const autoroles = await getModuleSettings<{ verificationRoleIds: string[] }>(internalId, 'autoroles');
  if (autoroles.verificationRoleIds?.length) {
    const roles = member.guild.roles.cache.filter((candidate) => autoroles.verificationRoleIds.includes(candidate.id) && !candidate.managed);
    await member.roles.add(roles, 'Verification autoroles').catch(() => undefined);
  }

  await prisma.verificationSession
    .updateMany({ where: { guildId: internalId, discordId: member.id }, data: { status: 'verified' } })
    .catch(() => undefined);

  await emitLog({
    guild: member.guild,
    event: 'member.rolesUpdate',
    summary: `${member.user.tag} verified and received <@&${config.verifiedRoleId}>`,
    targetId: member.id,
    bypassIgnore: true,
  });

  return { ok: true, message: 'You are verified. Welcome!' };
}

export async function checkCaptcha(member: GuildMember, submitted: string): Promise<{ ok: boolean; message: string }> {
  const internalId = await requireGuildId(member.guild.id);
  const session = await prisma.verificationSession.findUnique({ where: { guildId_discordId: { guildId: internalId, discordId: member.id } } });
  if (!session || session.status === 'verified') return { ok: false, message: 'No pending verification. Click Verify again.' };
  if (session.expiresAt.getTime() < Date.now()) return { ok: false, message: 'That code expired. Click Verify for a new one.' };
  if (session.attempts >= 5) return { ok: false, message: 'Too many attempts. Try again in a few minutes.' };
  if (session.code.toUpperCase() !== submitted.trim().toUpperCase()) {
    await prisma.verificationSession.update({ where: { id: session.id }, data: { attempts: { increment: 1 } } });
    return { ok: false, message: 'That code is not correct. Try again.' };
  }
  return grantVerifiedRole(member);
}

export function verificationResult(ok: boolean, message: string) {
  return ok ? successEmbed('Verified', message) : errorEmbed('Verification', message);
}
