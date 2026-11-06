'use client';

import { useParams } from 'next/navigation';
import { Overview } from '@/components/overview';

export default function GuildOverviewPage() {
  const params = useParams<{ guildId: string }>();
  return <Overview guildId={params.guildId} />;
}
