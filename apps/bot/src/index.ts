/** IRH CORE bot entry point. */

import { ActivityType, Events } from 'discord.js';
import { disconnectDatabase, logger, prisma, recordAudit } from '@irh/db';
import { env, requireToken } from './env.js';
import { createClient } from './client.js';
import { Scheduler } from './lib/scheduler.js';
import { registerAllJobs } from './modules/jobs.js';
import { registerCommands, syncCommands } from './commands/index.js';
import { registerInteractionHandlers } from './handlers/interactions.js';
import { registerMessageHandlers } from './handlers/messages.js';
import { registerMemberHandlers } from './handlers/members.js';
import { registerVoiceHandlers } from './handlers/voice.js';
import { registerLoggingHandlers } from './handlers/logging.js';
import { registerSecurityHandlers } from './handlers/security.js';
import { refreshInviteCache } from './modules/invites.js';
import { emitLog } from './lib/logging.js';
import { registerGuild } from './lib/settings.js';

const log = logger.child('bot');

async function main(): Promise<void> {
  const token = requireToken();
  const client = createClient();
  const scheduler = new Scheduler(client);

  registerCommands(client);
  registerInteractionHandlers(client);
  registerMessageHandlers(client);
  registerMemberHandlers(client);
  registerVoiceHandlers(client);
  registerLoggingHandlers(client);
  registerSecurityHandlers(client);
  registerAllJobs(client, scheduler);

  client.once(Events.ClientReady, async (ready) => {
    log.info('Bot ready', { user: ready.user.tag, guilds: ready.guilds.cache.size });
    ready.user.setPresence({ activities: [{ name: 'your server · /help', type: ActivityType.Watching }], status: 'online' });

    try {
      await syncCommands(ready);
    } catch (error) {
      log.error('Command registration failed', { error: String(error) });
    }

    for (const guild of ready.guilds.cache.values()) {
      try {
        await registerGuild(guild);
        await refreshInviteCache(guild);
        void emitLog({ guild, event: 'system.botStart', summary: `IRH CORE connected (${ready.user.tag})`, source: 'system' }).catch(() => undefined);
      } catch (error) {
        // One bad guild must never stop the others.
        log.warn('Guild initialisation failed', { guildId: guild.id, error: String(error) });
      }
    }

    await scheduler.start();

    const heartbeat = setInterval(() => {
      void prisma.systemEvent
        .create({
          data: {
            level: 'heartbeat',
            scope: 'bot',
            message: 'heartbeat',
            meta: {
              guilds: ready.guilds.cache.size,
              ping: ready.ws.ping,
              uptime: Math.round(process.uptime()),
              user: ready.user.tag,
            } as never,
          },
        })
        .catch(() => undefined);
      void prisma.systemEvent
        .deleteMany({ where: { level: 'heartbeat', createdAt: { lt: new Date(Date.now() - 3_600_000) } } })
        .catch(() => undefined);
    }, 30_000);
    heartbeat.unref();

    client.once(Events.ShardDisconnect, () => log.warn('Gateway disconnected — discord.js will reconnect automatically'));
    client.on(Events.Error, (error) => log.error('Client error', { error: String(error) }));
    client.on(Events.Warn, (message) => log.warn('Client warning', { message }));
  });

  client.on(Events.GuildCreate, async (guild) => {
    try {
      await registerGuild(guild);
      await refreshInviteCache(guild);
      log.info('Joined guild', { guildId: guild.id, name: guild.name });
    } catch (error) {
      log.warn('Failed to register guild', { guildId: guild.id, error: String(error) });
    }
  });

  client.on(Events.GuildDelete, async (guild) => {
    await prisma.guild.updateMany({ where: { discordId: guild.id }, data: { botJoinedAt: new Date(0) } }).catch(() => undefined);
    log.info('Removed from guild', { guildId: guild.id });
  });

  client.on(Events.GuildUnavailable, (guild) => log.warn('Guild unavailable (Discord outage)', { guildId: guild.id }));

  process.on('unhandledRejection', (reason) => log.error('Unhandled rejection', { reason: String(reason) }));
  process.on('uncaughtException', (error) => log.error('Uncaught exception', { error: String(error) }));

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}; shutting down`);
    const timeout = setTimeout(() => process.exit(1), 15_000);
    timeout.unref();
    try {
      await scheduler.stop();
      await client.destroy();
      await recordAudit({ action: 'system.bot_shutdown', actorType: 'system', targetType: 'bot' });
      await disconnectDatabase();
      process.exit(0);
    } catch (error) {
      log.error('Shutdown failed', { error: String(error) });
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await client.login(token);
  log.info('Login complete', { environment: env.nodeEnv });
}

main().catch((error) => {
  log.error('Fatal startup error', { error: String(error) });
  process.exit(1);
});
