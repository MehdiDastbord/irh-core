/** Message pipeline: honeypot → automod → custom commands → autoresponders → XP → reactions. */

import { Events, PermissionFlagsBits, type Client, type Message } from 'discord.js';
import { getModuleSettings, logger, prisma, requireGuildId } from '@irh/db';
import { renderTemplate } from '@irh/shared';
import { handleAutomod } from '../modules/automod.js';
import { handleHoneypot } from '../modules/security.js';
import { awardMessageXp } from '../modules/leveling.js';
import { runWorkflows } from '../modules/automations.js';

const log = logger.child('messages');

const cooldowns = new Map<string, number>();

export function registerMessageHandlers(client: Client): void {
  client.on(Events.MessageCreate, async (message: Message) => {
    try {
      if (!message.inGuild() || !message.member || !message.guild) return;
      if (message.author.bot) return;
      if (message.system) return;

      const guild = message.guild;

      // 1. Honeypot channels are checked before everything else.
      if (await handleHoneypot(guild, message.member, message.channelId)) {
        await message.delete().catch(() => undefined);
        return;
      }

      // 2. Auto moderation.
      const automodOutcome = await handleAutomod(message);
      if (['deleted', 'warned', 'timedout', 'kicked', 'banned'].includes(automodOutcome)) return;

      const internalId = await requireGuildId(guild.id);
      const custom = await getModuleSettings<{ enabled: boolean; prefix: string; maxCommands: number; defaultCooldownSec: number; allowVariables: boolean }>(
        internalId,
        'customcommands',
      );

      // 3. Custom prefix commands.
      if (custom.enabled && message.content.startsWith(custom.prefix)) {
        const [rawName, ...args] = message.content.slice(custom.prefix.length).trim().split(/\s+/);
        const name = rawName?.toLowerCase();
        if (name) {
          const command = await prisma.customCommand.findUnique({ where: { guildId_name: { guildId: internalId, name } } });
          if (command?.enabled) {
            const roles = (command.allowedRoleIds as string[]) ?? [];
            const allowed = !roles.length || roles.some((roleId) => message.member!.roles.cache.has(roleId)) || message.member!.permissions.has(PermissionFlagsBits.ManageMessages);
            if (!allowed) {
              await message.reply({ content: 'You cannot use that command.', allowedMentions: { repliedUser: false } }).catch(() => undefined);
              return;
            }
            const key = `cmd:${internalId}:${command.id}:${message.author.id}`;
            const cooldownMs = Math.max(command.cooldownSec, custom.defaultCooldownSec ?? 3) * 1000;
            const last = cooldowns.get(key) ?? 0;
            if (Date.now() - last < cooldownMs) return;
            cooldowns.set(key, Date.now());
            if (cooldowns.size > 10_000) cooldowns.clear();

            const rendered = custom.allowVariables
              ? renderTemplate(command.response, {
                  user: `<@${message.author.id}>`,
                  userTag: message.author.tag,
                  userName: message.author.username,
                  userId: message.author.id,
                  server: guild.name,
                  memberCount: guild.memberCount,
                })
              : command.response;
            void args;
            await message.reply({ content: rendered.slice(0, 2000), allowedMentions: { repliedUser: false, parse: [] } }).catch(() => undefined);
            await prisma.customCommand.update({ where: { id: command.id }, data: { uses: { increment: 1 } } }).catch(() => undefined);
            return;
          }
        }
      }

      // 4. Auto responders.
      const responders = await prisma.autoResponder.findMany({ where: { guildId: internalId, enabled: true }, take: 100 });
      if (responders.length) {
        const content = message.content.toLowerCase();
        const match = responders.find((responder) =>
          responder.matchType === 'exact'
            ? content.trim() === responder.trigger.toLowerCase()
            : responder.matchType === 'prefix'
              ? content.startsWith(responder.trigger.toLowerCase())
              : content.includes(responder.trigger.toLowerCase()),
        );
        if (match) {
          await message.reply({ content: match.response.slice(0, 2000), allowedMentions: { repliedUser: false, parse: [] } }).catch(() => undefined);
          return;
        }
      }

      // 5. Auto reactions.
      const reactions = await getModuleSettings<{ enabled: boolean; defaultEmojis: string[]; chancePercent: number; ignoreBots: boolean; channelIds: string[] }>(internalId, 'autoreactions');
      if (reactions.enabled && (!reactions.channelIds?.length || reactions.channelIds.includes(message.channelId))) {
        if (Math.random() * 100 <= (reactions.chancePercent ?? 100)) {
          const rules = await prisma.autoReactionRule.findMany({ where: { guildId: internalId, enabled: true }, take: 50 });
          for (const rule of rules) {
            let matches = false;
            try {
              if (rule.triggerType === 'all') matches = true;
              else if (rule.triggerType === 'keyword') matches = message.content.toLowerCase().includes(rule.pattern.toLowerCase());
              else if (rule.triggerType === 'regex') matches = new RegExp(rule.pattern, 'i').test(message.content);
            } catch {
              matches = false;
            }
            if (!matches) continue;
            for (const emoji of (rule.emojis as string[]) ?? []) {
              await message.react(emoji).catch(() => undefined);
            }
            break;
          }
          if (!rules.length) {
            for (const emoji of reactions.defaultEmojis ?? []) await message.react(emoji).catch(() => undefined);
          }
        }
      }

      // 6. XP + automations (run after replies so bot output is ignored).
      await awardMessageXp(message.member, message.channelId).catch(() => undefined);
      await runWorkflows('message.create', { guild, member: message.member, message }).catch(() => 0);
      await prisma.statSnapshot
        .upsert({
          where: { guildId_date: { guildId: internalId, date: new Date().toISOString().slice(0, 10) } },
          create: { guildId: internalId, date: new Date().toISOString().slice(0, 10), messages: 1 },
          update: { messages: { increment: 1 } },
        })
        .catch(() => undefined);

    } catch (error) {
      log.error('Message pipeline failed', { guildId: message.guild?.id, error: String(error) });
    }
  });

  log.info('Message handlers registered');
}
