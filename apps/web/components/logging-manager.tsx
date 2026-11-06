'use client';

import { LOG_EVENTS } from '@irh/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { channelLabel, useGuild } from './guild-context';
import { Alert, Badge, Button, Card, CardSkeleton, useToast } from './ui';

interface LogRow {
  key: string;
  label: string;
  group: string;
  enabled: boolean;
  channelIds: string[];
  configured: boolean;
}

export function LoggingManager() {
  const { guildId, channels } = useGuild();
  const { push } = useToast();
  const [rows, setRows] = useState<LogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [group, setGroup] = useState('All');
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api<{ events: LogRow[] }>(`/guilds/${guildId}/logging`);
      setRows(data.events);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load logging configuration');
    }
  }, [guildId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (row: LogRow, patch: Partial<LogRow>) => {
    setSavingKey(row.key);
    const next = { ...row, ...patch };
    setRows((current) => current?.map((entry) => (entry.key === row.key ? next : entry)) ?? null);
    try {
      await api(`/guilds/${guildId}/logging/${row.key}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: next.enabled, channelIds: next.channelIds }),
      });
      push(`${row.label} updated`, 'success');
    } catch (cause) {
      push(cause instanceof Error ? cause.message : 'Save failed', 'error');
      await load();
    } finally {
      setSavingKey(null);
    }
  };

  const groups = useMemo(() => ['All', ...new Set(LOG_EVENTS.map((event) => event.group))], []);
  const visible = useMemo(
    () =>
      (rows ?? []).filter((row) => {
        if (group !== 'All' && row.group !== group) return false;
        if (!filter.trim()) return true;
        return row.label.toLowerCase().includes(filter.toLowerCase()) || row.key.includes(filter.toLowerCase());
      }),
    [rows, group, filter],
  );

  const bulk = async (enabled: boolean) => {
    const events = visible.map((row) => row.key);
    if (!events.length) return;
    try {
      await api(`/guilds/${guildId}/logging/bulk`, { method: 'POST', body: JSON.stringify({ events, enabled }) });
      push(`${events.length} events ${enabled ? 'enabled' : 'disabled'}`, 'success');
      await load();
    } catch (cause) {
      push(cause instanceof Error ? cause.message : 'Bulk update failed', 'error');
    }
  };

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!rows) return <CardSkeleton rows={8} />;

  const textChannels = channels.filter((channel) => [0, 5].includes(channel.type));

  return (
    <div className="space-y-4">
      <Card className="card-pad">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-semibold text-white">Event routing</h2>
            <p className="mt-1 text-sm text-slate-400">
              {rows.filter((row) => row.enabled).length} of {rows.length} events enabled. Every event can target up to 5 channels.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => void bulk(true)}>
              Enable visible
            </Button>
            <Button variant="secondary" onClick={() => void bulk(false)}>
              Disable visible
            </Button>
          </div>
        </div>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input className="input sm:max-w-xs" placeholder="Filter events…" value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filter events" />
          <select className="input sm:max-w-[200px]" value={group} onChange={(event) => setGroup(event.target.value)} aria-label="Filter by group">
            {groups.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </div>
      </Card>

      <div className="space-y-3">
        {visible.map((row) => (
          <Card key={row.key} className="card-pad">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-slate-100">{row.label}</span>
                  <Badge>{row.group}</Badge>
                  <code className="text-[11px] text-slate-500">{row.key}</code>
                  {savingKey === row.key ? <span className="text-[11px] text-brand-300">saving…</span> : null}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {row.channelIds.length === 0 ? (
                    <span className="text-xs text-slate-500">No destination — uses the fallback channel.</span>
                  ) : (
                    row.channelIds.map((channelId) => {
                      const channel = channels.find((entry) => entry.id === channelId);
                      return (
                        <span key={channelId} className="badge">
                          {channel ? channelLabel(channel) : channelId}
                          <button
                            type="button"
                            className="ml-1 text-slate-500 hover:text-red-300"
                            aria-label="Remove channel"
                            onClick={() => void save(row, { channelIds: row.channelIds.filter((id) => id !== channelId) })}
                          >
                            ✕
                          </button>
                        </span>
                      );
                    })
                  )}
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <select
                  className="input max-w-[240px]"
                  value=""
                  aria-label={`Add destination channel for ${row.label}`}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (!value || row.channelIds.includes(value)) return;
                    void save(row, { channelIds: [...row.channelIds.slice(0, 4), value] });
                  }}
                >
                  <option value="">＋ Add channel…</option>
                  {textChannels.map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      {channelLabel(channel)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  role="switch"
                  aria-checked={row.enabled}
                  aria-label={`${row.enabled ? 'Disable' : 'Enable'} ${row.label}`}
                  onClick={() => void save(row, { enabled: !row.enabled })}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition ${row.enabled ? 'bg-brand-gradient' : 'bg-ink-700'}`}
                >
                  <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${row.enabled ? 'left-[22px]' : 'left-0.5'}`} />
                </button>
              </div>
            </div>
          </Card>
        ))}
        {visible.length === 0 ? <Card className="card-pad text-sm text-slate-500">No events match that filter.</Card> : null}
      </div>
    </div>
  );
}
