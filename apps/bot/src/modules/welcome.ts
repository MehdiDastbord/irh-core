/** Welcome and goodbye messages with optional generated images. */

import { AttachmentBuilder, type Guild, type GuildMember } from 'discord.js';
import { getModuleSettings, logger, requireGuildId } from '@irh/db';
import { renderTemplate } from '@irh/shared';
import { baseEmbed, COLORS } from '../lib/embed.js';
import { safeDm } from '../lib/discord-utils.js';
import { renderWelcomeCard } from '../lib/image.js';

const log = logger.child('welcome');

export interface WelcomeSettings {
  enabled: boolean;
  channelId: string | null;
  message: string;
  useEmbed: boolean;
  embedColor: number;
  thumbnail: boolean;
  dmEnabled: boolean;
  dmMessage: string;
  imageEnabled: boolean;
  imageTheme: string;
  goodbyeEnabled: boolean;
  goodbyeChannelId: string | null;
  goodbyeMessage: string;
}

export function welcomeVariables(member: GuildMember, extra: { inviter?: string | null; invites?: number } = {}) {
  return {
    user: `<@${member.id}>`,
    userTag: member.user.tag,
    userName: member.user.username,
    userId: member.id,
    server: member.guild.name,
    memberCount: member.guild.memberCount,
    createdAt: member.user.createdAt.toISOString().slice(0, 10),
    joinedAt: member.joinedAt?.toISOString().slice(0, 10) ?? '',
    inviter: extra.inviter ? `<@${extra.inviter}>` : 'Unknown',
    invites: extra.invites ?? 0,
  };
}

export async function sendWelcome(member: GuildMember, extra: { inviter?: string | null; invites?: number } = {}): Promise<void> {
  const settings = await getModuleSettings<WelcomeSettings>(await requireGuildId(member.guild.id), 'welcome');
  if (!settings.enabled) return;
  const vars = welcomeVariables(member, extra);
  const content = renderTemplate(settings.message ?? '', vars);

  if (settings.channelId) {
    const channel = await member.guild.channels.fetch(settings.channelId).catch(() => null);
    if (channel && channel.isTextBased() && 'send' in channel) {
      const files: AttachmentBuilder[] = [];
      if (settings.imageEnabled) {
        try {
          const png = renderWelcomeCard({
            username: member.user.username,
            serverName: member.guild.name,
            memberCount: member.guild.memberCount,
            theme: settings.imageTheme,
          });
          files.push(new AttachmentBuilder(png, { name: 'welcome.png' }));
        } catch (error) {
          log.warn('Welcome image generation failed', { guildId: member.guild.id, error: String(error) });
        }
      }
      const payload = settings.useEmbed
        ? {
            embeds: [
              baseEmbed({ description: content, color: settings.embedColor ?? COLORS.brand })
                .setAuthor({ name: member.user.tag, iconURL: member.user.displayAvatarURL() })
                .setThumbnail(settings.thumbnail ? member.user.displayAvatarURL({ size: 256 }) : null)
                .setImage(files.length ? 'attachment://welcome.png' : null),
            ],
            files,
          }
        : { content, files };
      await channel.send(payload).catch((error) => log.warn('Welcome send failed', { error: String(error) }));
    }
  }

  if (settings.dmEnabled) {
    await safeDm(member, { content: renderTemplate(settings.dmMessage ?? 'Welcome to {server}!', vars) });
  }
}

export async function sendGoodbye(member: GuildMember): Promise<void> {
  const settings = await getModuleSettings<WelcomeSettings>(await requireGuildId(member.guild.id), 'welcome');
  if (!settings.goodbyeEnabled || !settings.goodbyeChannelId) return;
  const channel = await member.guild.channels.fetch(settings.goodbyeChannelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !('send' in channel)) return;
  const content = renderTemplate(settings.goodbyeMessage ?? '{user} left.', welcomeVariables(member));
  await channel.send({ embeds: [baseEmbed({ description: content, color: COLORS.muted })] }).catch(() => undefined);
}

export function welcomePreview(settings: WelcomeSettings, guild: Guild, member: GuildMember): string {
  return renderTemplate(settings.message ?? '', welcomeVariables(member, { inviter: null, invites: 0 }));
}
