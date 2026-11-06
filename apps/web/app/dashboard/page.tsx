'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { api } from '@/lib/api';
import { Spinner } from '@/components/ui';

export default function DashboardIndex() {
  const router = useRouter();
  useEffect(() => {
    api<{ items: { id: string; botPresent: boolean }[] }>('/guilds')
      .then((data) => {
        const preferred = data.items.find((guild) => guild.botPresent) ?? data.items[0];
        if (preferred) router.replace(`/dashboard/g/${preferred.id}`);
      })
      .catch(() => router.replace('/'));
  }, [router]);

  return (
    <div className="grid min-h-[50vh] place-items-center text-sm text-slate-400">
      <span className="flex items-center gap-2">
        <Spinner /> Choosing a server…
      </span>
    </div>
  );
}
