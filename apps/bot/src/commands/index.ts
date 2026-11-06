/** Slash command registry and loader. */

import {
  Collection,
  REST,
  Routes,
  type ChatInputCommandInteraction,
  type Client,
  type SlashCommandBuilder,
  type SlashCommandOptionsOnlyBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';
import { logger } from '@irh/db';
import { env } from '../env.js';
import { moderationCommands } from './moderation.js';
import { communityCommands } from './community.js';
import { utilityCommands } from './utility.js';

export interface Command {
  data: SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder | SlashCommandOptionsOnlyBuilder;
  execute: (interaction: ChatInputCommandInteraction, client: Client) => Promise<void>;
  ownerOnly?: boolean;
}

export const commands: Command[] = [...moderationCommands, ...communityCommands, ...utilityCommands];

declare module 'discord.js' {
  interface Client {
    commands: Collection<string, Command>;
  }
}

export function registerCommands(client: Client): void {
  client.commands = new Collection();
  for (const command of commands) client.commands.set(command.data.name, command);
}

export async function syncCommands(client: Client): Promise<number> {
  const body = commands.map((command) => command.data.toJSON());
  const rest = new REST({ version: '10' }).setToken(env.token || '');
  const clientId = client.user?.id ?? env.clientId;
  if (!clientId) throw new Error('Cannot register commands without a client id');

  if (env.devGuildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, env.devGuildId), { body });
    logger.info('commands', `Registered ${body.length} guild commands`, { guildId: env.devGuildId });
    return body.length;
  }
  await rest.put(Routes.applicationCommands(clientId), { body });
  logger.info('commands', `Registered ${body.length} global commands`);
  return body.length;
}
