'use client';

import Link from 'next/link';
import { useApi, formatNumber, relativeTime } from '@/lib/api';
import { LineChart } from './charts';
import { Alert, Badge, Card, CardSkeleton, SectionHeader, StatCard } from './ui';

interface GrowthPoint {
  date: string;
  members: number;
  messages: number;
  joins: number;
  leaves: number;
}

interface OverviewResponse {
  guild: { name: string; memberCount?: number; botPresent?: boolean };
  memberCount: number;
  onlineCount: number;
  boostCount: number;
  enabledModules: string[];
  moderation: Record<string, number>;
  tickets: Record<string, number>;
  activity: { messages: number; joins: number; leaves: number; invites: number; tickets: number };
  growth: GrowthPoint[];
  securityIncidents: number;
  activeGiveaways: number;
  scheduledJobs: Record<string, number>;
  lastSettingsUpdate: string | null;
}

export function Overview({ guildId }: { guildId: string }) {
  const { data, error, loading } = useApi<OverviewResponse>(`/guilds/${guildId}/overview`);

  if (error) return <Alert tone="error">{error}</Alert>;
  if (loading || !data) return <CardSkeleton rows={8} />;

  const growth = data.growth ?? [];
  const hasGrowth = growth.some((point) => point.members > 0 || point.messages > 0 || point.joins > 0);
  const jobs = data.scheduledJobs ?? {};
  const pendingJobs = (jobs.pending ?? 0) + (jobs.running ?? 0);

  return (
    <div className="space-y-5">
      <SectionHeader
        title={`${data.guild?.name ?? 'Server'} overview`}
        description="Live values from the IRH CORE database. Figures remain empty until the bot records activity."
        badge={<Badge tone={data.guild?.botPresent ? 'success' : 'warning'}>{data.guild?.botPresent ? 'Bot connected' : 'Bot offline'}</Badge>}
        actions={
          <>
            <Link href={`/dashboard/g/${guildId}/logging`} className="btn-secondary">
              Logging
            </Link>
            <Link href={`/dashboard/g/${guildId}/settings`} className="btn-primary">
              Server settings
            </Link>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Members" value={formatNumber(data.memberCount)} hint={data.onlineCount ? `${formatNumber(data.onlineCount)} online when last sampled` : 'Online count not sampled yet'} />
        <StatCard label="Messages (7d)" value={formatNumber(data.activity?.messages ?? 0)} hint={`${formatNumber(data.activity?.joins ?? 0)} joins · ${formatNumber(data.activity?.leaves ?? 0)} leaves`} />
        <StatCard
          label="Open tickets"
          value={formatNumber(data.tickets?.open ?? 0)}
          hint={`${formatNumber(data.tickets?.total ?? data.tickets?.closed ?? 0)} total recorded`}
          tone={(data.tickets?.open ?? 0) > 0 ? 'warning' : 'default'}
        />
        <StatCard
          label="Security incidents"
          value={formatNumber(data.securityIncidents)}
          hint={data.securityIncidents ? 'Open — review the security page' : 'No open incidents'}
          tone={data.securityIncidents ? 'danger' : 'success'}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="card-pad lg:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-white">Server growth</h2>
              <p className="text-xs text-slate-500">Daily snapshots — members and messages</p>
            </div>
            <Badge>{growth.length} days</Badge>
          </div>
          {hasGrowth ? (
            <LineChart data={growth.map((point) => ({ label: point.date, value: point.members }))} />
          ) : (
            <div className="flex h-40 flex-col items-center justify-center rounded-xl border border-dashed border-white/10 text-center">
              <p className="text-sm text-slate-300">No snapshots recorded yet</p>
              <p className="mt-1 max-w-sm text-xs text-slate-500">
                The bot writes one snapshot per day when it is running. Nothing is simulated here.
              </p>
            </div>
          )}
        </Card>

        <Card className="card-pad">
          <h2 className="text-base font-semibold text-white">Operations</h2>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-slate-400">Active giveaways</dt>
              <dd className="font-medium text-slate-100">{formatNumber(data.activeGiveaways)}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-slate-400">Queued jobs</dt>
              <dd className="font-medium text-slate-100">{formatNumber(pendingJobs)}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-slate-400">Boosts</dt>
              <dd className="font-medium text-slate-100">{formatNumber(data.boostCount)}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-slate-400">Invites (7d)</dt>
              <dd className="font-medium text-slate-100">{formatNumber(data.activity?.invites ?? 0)}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-slate-400">Last config change</dt>
              <dd className="font-medium text-slate-100">{data.lastSettingsUpdate ? relativeTime(data.lastSettingsUpdate) : 'Never'}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-slate-400">Enabled modules</dt>
              <dd className="font-medium text-slate-100">{formatNumber(data.enabledModules.length)}</dd>
            </div>
          </dl>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link href={`/dashboard/g/${guildId}/moderation`} className="btn-secondary text-xs">
              Moderation
            </Link>
            <Link href={`/dashboard/g/${guildId}/system`} className="btn-secondary text-xs">
              System health
            </Link>
          </div>
        </Card>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { id: 'moderation', label: 'Moderation', body: `${formatNumber(data.moderation?.total ?? data.moderation?.totalCases ?? 0)} cases recorded` },
          { id: 'tickets', label: 'Tickets', value: `${formatNumber(data.tickets?.open ?? 0)} open` },
          { id: 'giveaways', label: 'Giveaways', body: `${formatNumber(data.activeGiveaways)} running` },
          { id: 'statistics', label: 'Statistics', body: 'Growth and activity charts' },
        ].map((item) => (
          <Link key={item.id} href={`/dashboard/g/${guildId}/${item.id}`} className="card card-pad transition hover:border-brand-500/30 hover:bg-white/[0.03]">
            <p className="text-sm font-semibold text-white">{item.label}</p>
            <p className="mt-1 text-xs text-slate-400">{item.value ?? item.body}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
