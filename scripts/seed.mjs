#!/usr/bin/env node
/**
 * Database bootstrap check.
 *
 * IRH CORE never invents statistics or demo servers. This script verifies the
 * connection, prints the schema state and (only with SEED_DEMO=1) creates a
 * clearly-labelled demo guild for UI development.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.$connect();
  const [guilds, users, sessions, jobs] = await Promise.all([
    prisma.guild.count(),
    prisma.user.count(),
    prisma.session.count(),
    prisma.scheduledJob.count({ where: { status: 'pending' } }),
  ]);
  console.log(`Database OK — ${guilds} guild(s), ${users} user(s), ${sessions} session(s), ${jobs} pending job(s).`);

  if (process.env.SEED_DEMO === '1') {
    const guild = await prisma.guild.upsert({
      where: { discordId: '000000000000000001' },
      create: { discordId: '000000000000000001', name: 'IRH Demo (not a real server)', memberCount: 0 },
      update: {},
    });
    console.log(`Demo guild ready: ${guild.id} — statistics stay at zero until a real Discord guild reports data.`);
  } else {
    console.log('Set SEED_DEMO=1 to create a labelled demo guild. Real servers are registered by the bot on guild join.');
  }

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error('Seed/bootstrap failed:', error instanceof Error ? error.message : error);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
