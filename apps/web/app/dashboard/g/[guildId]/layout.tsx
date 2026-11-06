'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { GuildProvider, type GuildInfo } from '@/components/guild-context';
import { useToast } from '@/components/ui';

export default function GuildLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ guildId: string }>();
  const guildId = params.guildId;
  const [guild, setGuild] = useState<GuildInfo | null>(null);
  const { push } = useToast();

  useEffect(() => {
    setGuild(null);
    api<{ items: (Omit<GuildInfo, 'discordId'> & { id: string })[] }>('/guilds')
      .then((data) => {
        const found = data.items.find((item) => item.id === guildId);
        if (found) setGuild({ ...found, discordId: found.id });
      })
      .catch((cause: unknown) => push(cause instanceof Error ? cause.message : 'Could not load server', 'error'));
  }, [guildId, push]);

  return (
    <GuildProvider guildId={guildId} guild={guild}>
      {children}
    </GuildProvider>
  );
}
