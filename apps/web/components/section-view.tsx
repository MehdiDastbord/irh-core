'use client';

import { useEffect, useState } from 'react';
import { api, formatDate, useApi, formatNumber } from '@/lib/api';
import { sectionById } from '@/lib/sections';
import { LoggingManager } from './logging-manager';
import { SettingsForm } from './settings-form';
import { CrudManager, type CrudField } from './crud';
import { LineChart, BarList } from './charts';
import { useGuild } from './guild-context';
import { Alert, Badge, Button, Card, CardSkeleton, EmptyState, SectionHeader, StatCard, useToast } from './ui';

export function SectionView({ sectionId, guildId }: { sectionId: string; guildId: string }) {
  const section = sectionById(sectionId);
  if (!section) return <EmptyState title="Unknown page" />;

  const header = <SectionHeader title={section.label} description={section.description} badge={<Badge tone="info">{section.group}</Badge>} />;

  const body = (() => {
    switch (sectionId) {
      case 'settings':
        return <SettingsView />;
      case 'moderation':
        return <ModerationView guildId={guildId} />;
      case 'automod':
        return <SettingsForm moduleId="automod" />;
      case 'security':
        return <SecurityView guildId={guildId} />;
      case 'logging':
        return <LoggingManager />;
      case 'welcome':
        return <TestPostView moduleId="welcome" guildId={guildId} path="welcome/test" label="Send welcome preview" />;
      case 'verification':
        return <TestPostView moduleId="verification" guildId={guildId} path="verification/post" label="Post verification panel" />;
      case 'autoroles':
        return <SettingsForm moduleId="autoroles" />;
      case 'reactionroles':
        return <ReactionRolesView guildId={guildId} />;
      case 'tickets':
        return <TicketsView guildId={guildId} />;
      case 'voicemaster':
        return <VoiceMasterView guildId={guildId} />;
      case 'leveling':
        return <LevelingView guildId={guildId} />;
      case 'statistics':
        return <StatisticsView guildId={guildId} />;
      case 'giveaways':
        return <GiveawaysView guildId={guildId} />;
      case 'invites':
        return <InvitesView guildId={guildId} />;
      case 'rss':
        return <FeedsView guildId={guildId} />;
      case 'announcements':
        return <AnnouncementsView guildId={guildId} />;
      case 'emojis':
        return <EmojisView guildId={guildId} />;
      case 'autoreactions':
        return <AutoReactionsView guildId={guildId} />;
      case 'customcommands':
        return <CustomCommandsView guildId={guildId} />;
      case 'automations':
        return <AutomationsView guildId={guildId} />;
      case 'integrations':
        return <IntegrationsView guildId={guildId} />;
      case 'audit':
        return <AuditView guildId={guildId} />;
      case 'backups':
        return <BackupsView guildId={guildId} />;
      case 'status':
        return <StatusView />;
      case 'system':
        return <SystemView />;
      default:
        return <EmptyState title="Nothing to show" />;
    }
  })();

  return (
    <div className="space-y-5">
      {header}
      {body}
    </div>
  );
}

/* ── settings ───────────────────────────────────────────────── */

function SettingsView() {
  const { guild, botPresent } = useGuild();
  return (
    <div className="space-y-5">
      {!botPresent ? (
        <Alert tone="warning">
          IRH CORE is not in this server yet. Configuration still saves, but channel and role pickers stay empty until the bot is invited.
        </Alert>
      ) : null}
      <Card className="card-pad">
        <h2 className="text-base font-semibold text-white">Identity</h2>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs uppercase tracking-wider text-slate-500">Server</dt>
            <dd className="mt-1 text-slate-200">{guild?.name ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider text-slate-500">Discord ID</dt>
            <dd className="mt-1 font-mono text-xs text-slate-300">{guild?.discordId ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wider text-slate-500">Access</dt>
            <dd className="mt-1 text-slate-200">{guild?.accessLevel ?? '—'}</dd>
          </div>
        </dl>
      </Card>
      <SettingsForm moduleId="general" />
    </div>
  );
}

/* ── moderation ─────────────────────────────────────────────── */

interface CaseRow {
  id: string;
  caseNumber: number;
  action: string;
  targetId: string;
  moderatorId: string | null;
  reason: string | null;
  active: boolean;
  createdAt: string;
}

function ModerationView({ guildId }: { guildId: string }) {
  const cases = useApi<{ items: CaseRow[]; total: number }>(`/guilds/${guildId}/moderation/cases?page=1&pageSize=15`);
  const { data: stats } = useApi<Record<string, number>>(`/guilds/${guildId}/moderation/stats`);
  const { push } = useToast();
  const [action, setAction] = useState('warn');
  const [targetId, setTargetId] = useState('');
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState(10);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await api(`/guilds/${guildId}/moderation/actions`, {
        method: 'POST',
        body: JSON.stringify({
          action,
          targetId: targetId.replace(/\D/g, ''),
          reason: reason || undefined,
          ...(action === 'timeout' ? { durationMs: minutes * 60_000 } : {}),
        }),
      });
      push('Moderation action completed', 'success');
      setTargetId('');
      setReason('');
      cases.reload();
    } catch (cause) {
      push(cause instanceof Error ? cause.message : 'Action failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total cases" value={formatNumber(stats?.total ?? stats?.totalCases ?? 0)} />
        <StatCard label="Bans" value={formatNumber(stats?.bans ?? 0)} />
        <StatCard label="Warnings" value={formatNumber(stats?.warnings ?? 0)} />
        <StatCard label="Timeouts" value={formatNumber(stats?.timeouts ?? 0)} />
      </div>

      <Card className="card-pad">
        <h2 className="text-base font-semibold text-white">Quick action</h2>
        <p className="mt-1 text-sm text-slate-400">Runs through the bot with hierarchy checks and creates a moderation case.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <select className="input" value={action} onChange={(event) => setAction(event.target.value)} aria-label="Action">
            {['warn', 'timeout', 'kick', 'ban', 'unban', 'softban'].map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
          <input className="input" placeholder="Member ID" value={targetId} onChange={(event) => setTargetId(event.target.value)} aria-label="Member ID" />
          {action === 'timeout' ? (
            <input className="input" type="number" min={1} value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} aria-label="Minutes" />
          ) : null}
          <input className="input" placeholder="Reason" value={reason} onChange={(event) => setReason(event.target.value)} aria-label="Reason" />
          <Button loading={busy} disabled={!targetId.trim()} onClick={() => void submit()}>
            Apply
          </Button>
        </div>
      </Card>

      <Card className="card-pad">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">Recent cases</h2>
          <Badge>{formatNumber(cases.data?.total ?? 0)} total</Badge>
        </div>
        {cases.loading ? (
          <CardSkeleton rows={5} />
        ) : cases.error ? (
          <Alert tone="error">{cases.error}</Alert>
        ) : cases.data?.items.length ? (
          <div className="table-wrap">
            <table className="w-full">
              <thead className="bg-white/[0.02]">
                <tr>
                  <th className="th">Case</th>
                  <th className="th">Action</th>
                  <th className="th">Target</th>
                  <th className="th">Moderator</th>
                  <th className="th">Reason</th>
                  <th className="th">Created</th>
                  <th className="th">State</th>
                </tr>
              </thead>
              <tbody>
                {cases.data.items.map((item) => (
                  <tr key={item.id} className="row">
                    <td className="td font-mono text-xs">#{item.caseNumber}</td>
                    <td className="td capitalize">{item.action}</td>
                    <td className="td font-mono text-xs">{item.targetId}</td>
                    <td className="td font-mono text-xs">{item.moderatorId ?? '—'}</td>
                    <td className="td max-w-[240px] truncate">{item.reason ?? '—'}</td>
                    <td className="td">{formatDate(item.createdAt)}</td>
                    <td className="td">
                      <Badge tone={item.active ? 'success' : 'default'}>{item.active ? 'active' : 'expired'}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No moderation cases yet" description="Cases are created when a moderator uses a command or this page." />
        )}
      </Card>

      <SettingsForm moduleId="moderation" />
    </div>
  );
}

/* ── welcome / verification ─────────────────────────────────── */

function TestPostView({ moduleId, guildId, path, label }: { moduleId: string; guildId: string; path: string; label: string }) {
  const { push } = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-5">
      <Card className="card-pad">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-white">Live test</h2>
            <p className="mt-1 text-sm text-slate-400">Sends the configured panel to the channel saved in these settings.</p>
          </div>
          <Button
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api(`/guilds/${guildId}/${path}`, { method: 'POST', body: JSON.stringify({}) });
                push('Posted to Discord', 'success');
              } catch (cause) {
                push(cause instanceof Error ? cause.message : 'Could not post', 'error');
              } finally {
                setBusy(false);
              }
            }}
          >
            {label}
          </Button>
        </div>
      </Card>
      <SettingsForm moduleId={moduleId} />
    </div>
  );
}

/* ── security ───────────────────────────────────────────────── */

interface IncidentRow {
  id: string;
  type: string;
  severity: string;
  status: string;
  actorId: string | null;
  description: string;
  actionTaken: string | null;
  createdAt: string;
}

function SecurityView({ guildId }: { guildId: string }) {
  const incidents = useApi<{ items: IncidentRow[] }>(`/guilds/${guildId}/security/incidents?page=1&pageSize=15`);
  const trusted = useApi<{ items: { id: string; userId: string; reason: string | null }[] }>(`/guilds/${guildId}/security/trusted`);
  const { push } = useToast();
  const [userId, setUserId] = useState('');
  const [reason, setReason] = useState('');

  const resolve = async (id: string) => {
    try {
      await api(`/guilds/${guildId}/security/incidents/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'resolved' }) });
      push('Incident resolved', 'success');
      incidents.reload();
    } catch (cause) {
      push(cause instanceof Error ? cause.message : 'Update failed', 'error');
    }
  };

  return (
    <div className="space-y-5">
      <Card className="card-pad">
        <h2 className="text-base font-semibold text-white">Trusted users</h2>
        <p className="mt-1 text-sm text-slate-400">Trusted users are exempt from anti-nuke actions.</p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input className="input sm:max-w-[220px]" placeholder="User ID" value={userId} onChange={(event) => setUserId(event.target.value)} aria-label="Trusted user ID" />
          <input className="input sm:max-w-xs" placeholder="Reason (optional)" value={reason} onChange={(event) => setReason(event.target.value)} aria-label="Reason" />
          <Button
            disabled={!userId.trim()}
            onClick={async () => {
              try {
                await api(`/guilds/${guildId}/security/trusted`, { method: 'POST', body: JSON.stringify({ userId: userId.replace(/\D/g, ''), reason: reason || undefined }) });
                push('User trusted', 'success');
                setUserId('');
                setReason('');
                trusted.reload();
              } catch (cause) {
                push(cause instanceof Error ? cause.message : 'Failed', 'error');
              }
            }}
          >
            Add trusted user
          </Button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {trusted.data?.items.length ? (
            trusted.data.items.map((item) => (
              <span key={item.id} className="badge">
                <span className="font-mono text-xs">{item.userId}</span>
                <button
                  type="button"
                  className="ml-1 text-slate-500 hover:text-red-300"
                  aria-label={`Remove ${item.userId}`}
                  onClick={async () => {
                    await api(`/guilds/${guildId}/security/trusted/${item.userId}`, { method: 'DELETE' }).catch(() => undefined);
                    trusted.reload();
                  }}
                >
                  ✕
                </button>
              </span>
            ))
          ) : (
            <p className="text-xs text-slate-500">No trusted users configured.</p>
          )}
        </div>
      </Card>

      <Card className="card-pad">
        <h2 className="mb-3 text-base font-semibold text-white">Incidents</h2>
        {incidents.loading ? (
          <CardSkeleton rows={4} />
        ) : incidents.data?.items.length ? (
          <div className="table-wrap">
            <table className="w-full">
              <thead className="bg-white/[0.02]">
                <tr>
                  <th className="th">Type</th>
                  <th className="th">Severity</th>
                  <th className="th">Actor</th>
                  <th className="th">Description</th>
                  <th className="th">When</th>
                  <th className="th">Status</th>
                </tr>
              </thead>
              <tbody>
                {incidents.data.items.map((incident) => (
                  <tr key={incident.id} className="row">
                    <td className="td">{incident.type}</td>
                    <td className="td">
                      <Badge tone={incident.severity === 'critical' ? 'danger' : incident.severity === 'high' ? 'warning' : 'default'}>{incident.severity}</Badge>
                    </td>
                    <td className="td font-mono text-xs">{incident.actorId ?? '—'}</td>
                    <td className="td max-w-[320px] truncate">{incident.description}</td>
                    <td className="td">{formatDate(incident.createdAt)}</td>
                    <td className="td">
                      {incident.status === 'open' ? (
                        <Button variant="secondary" className="px-2 py-1 text-xs" onClick={() => void resolve(incident.id)}>
                          Resolve
                        </Button>
                      ) : (
                        <Badge tone="success">{incident.status}</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No security incidents" description="Anti-nuke detections will appear here with audit-log evidence." />
        )}
      </Card>

      <SettingsForm moduleId="security" />
    </div>
  );
}

/* ── reaction roles ─────────────────────────────────────────── */

function ReactionRolesView({ guildId }: { guildId: string }) {
  const { push } = useToast();
  const fields: CrudField[] = [
    { key: 'name', label: 'Panel name', type: 'text', required: true, default: '' },
    { key: 'description', label: 'Description', type: 'textarea', default: '' },
    { key: 'channelId', label: 'Channel', type: 'channel', required: true, channelTypes: ['text'] },
    { key: 'mode', label: 'Mode', type: 'select', options: [
      { value: 'button', label: 'Buttons' },
      { value: 'select', label: 'Select menu' },
      { value: 'reaction', label: 'Reactions' },
    ], default: 'button' },
    { key: 'unique', label: 'Only one role per member', type: 'boolean', default: false },
    { key: 'options', label: 'Options (JSON)', type: 'json', description: 'Array of { roleId, label, emoji, description }', default: [] },
  ];
  return (
    <div className="space-y-5">
      <CrudManager
        title="Role panels"
        description="Create a panel, then post it to its channel."
        path={`/guilds/${guildId}/reaction-roles`}
        fields={fields}
        columns={[
          { key: 'name', label: 'Name' },
          { key: 'mode', label: 'Mode' },
          { key: 'channelId', label: 'Channel', render: (item) => <span className="font-mono text-xs">{String(item.channelId)}</span> },
          { key: 'options', label: 'Options', render: (item) => `${Array.isArray(item.options) ? item.options.length : 0} roles` },
        ]}
        createLabel="Create panel"
        rowActions={(item) => (
          <Button
            variant="secondary"
            className="px-2.5 py-1.5 text-xs"
            onClick={async () => {
              try {
                await api(`/guilds/${guildId}/reaction-roles/${String(item.id)}/post`, { method: 'POST', body: JSON.stringify({}) });
                push('Panel posted', 'success');
              } catch (cause) {
                push(cause instanceof Error ? cause.message : 'Post failed', 'error');
              }
            }}
          >
            Post
          </Button>
        )}
      />
      <SettingsForm moduleId="reactionroles" />
    </div>
  );
}

/* ── tickets ────────────────────────────────────────────────── */

function TicketsView({ guildId }: { guildId: string }) {
  const { push } = useToast();
  const tickets = useApi<{ items: { id: string; number: number; subject: string; status: string; userId: string; createdAt: string }[]; stats?: Record<string, number> }>(
    `/guilds/${guildId}/tickets?page=1&pageSize=15`,
  );

  const fields: CrudField[] = [
    { key: 'name', label: 'Panel name', type: 'text', required: true, default: '' },
    { key: 'description', label: 'Description', type: 'textarea', default: '' },
    { key: 'channelId', label: 'Panel channel', type: 'channel', required: true, channelTypes: ['text'] },
    { key: 'categoryId', label: 'Ticket category', type: 'channel', channelTypes: ['category'] },
    { key: 'buttonLabel', label: 'Button label', type: 'text', default: 'Open a ticket' },
    { key: 'supportRoleIds', label: 'Support roles', type: 'roles', default: [] },
    { key: 'formFields', label: 'Form fields (JSON)', type: 'json', description: '[{ key, label, style, required, maxLength }]', default: [] },
    { key: 'defaultPriority', label: 'Default priority', type: 'select', options: ['low', 'normal', 'high', 'urgent'].map((value) => ({ value, label: value })), default: 'normal' },
  ];

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Open" value={formatNumber(tickets.data?.stats?.open ?? 0)} tone="warning" />
        <StatCard label="Total" value={formatNumber(tickets.data?.stats?.total ?? tickets.data?.stats?.closed ?? 0)} />
        <StatCard label="Avg rating" value={tickets.data?.stats?.avgRating ? tickets.data.stats.avgRating.toFixed(2) : '—'} />
        <StatCard label="Claimed" value={formatNumber(tickets.data?.stats?.claimed ?? 0)} />
      </div>

      <Card className="card-pad">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">Tickets</h2>
          <Button variant="secondary" onClick={() => tickets.reload()}>
            Refresh
          </Button>
        </div>
        {tickets.loading ? (
          <CardSkeleton rows={4} />
        ) : tickets.data?.items.length ? (
          <div className="table-wrap">
            <table className="w-full">
              <thead className="bg-white/[0.02]">
                <tr>
                  <th className="th">#</th>
                  <th className="th">Subject</th>
                  <th className="th">Opened by</th>
                  <th className="th">Status</th>
                  <th className="th">Created</th>
                  <th className="th" />
                </tr>
              </thead>
              <tbody>
                {tickets.data.items.map((ticket) => (
                  <tr key={ticket.id} className="row">
                    <td className="td font-mono text-xs">#{ticket.number}</td>
                    <td className="td max-w-[280px] truncate">{ticket.subject}</td>
                    <td className="td font-mono text-xs">{ticket.userId}</td>
                    <td className="td">
                      <Badge tone={ticket.status === 'open' ? 'success' : ticket.status === 'claimed' ? 'info' : 'default'}>{ticket.status}</Badge>
                    </td>
                    <td className="td">{formatDate(ticket.createdAt)}</td>
                    <td className="td text-right">
                      {ticket.status !== 'closed' ? (
                        <Button
                          variant="danger"
                          className="px-2.5 py-1.5 text-xs"
                          onClick={async () => {
                            try {
                              await api(`/guilds/${guildId}/tickets/${ticket.id}/close`, { method: 'POST', body: JSON.stringify({}) });
                              push('Close queued', 'success');
                              tickets.reload();
                            } catch (cause) {
                              push(cause instanceof Error ? cause.message : 'Failed', 'error');
                            }
                          }}
                        >
                          Close
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No tickets yet" description="Create a panel below and post it to your support channel." />
        )}
      </Card>

      <CrudManager
        title="Ticket panels"
        path={`/guilds/${guildId}/tickets/panels`}
        fields={fields}
        columns={[
          { key: 'name', label: 'Name' },
          { key: 'channelId', label: 'Channel', render: (item) => <span className="font-mono text-xs">{String(item.channelId ?? '—')}</span> },
          { key: 'formFields', label: 'Form fields', render: (item) => `${Array.isArray(item.formFields) ? item.formFields.length : 0}` },
          { key: 'enabled', label: 'Enabled', render: (item) => <Badge tone={item.enabled ? 'success' : 'default'}>{item.enabled ? 'yes' : 'no'}</Badge> },
        ]}
        createLabel="Create panel"
        rowActions={(item) => (
          <Button
            variant="secondary"
            className="px-2.5 py-1.5 text-xs"
            onClick={async () => {
              try {
                await api(`/guilds/${guildId}/tickets/panels/${String(item.id)}/post`, { method: 'POST', body: JSON.stringify({}) });
                push('Panel posted', 'success');
              } catch (cause) {
                push(cause instanceof Error ? cause.message : 'Post failed', 'error');
              }
            }}
          >
            Post
          </Button>
        )}
      />
      <SettingsForm moduleId="tickets" />
    </div>
  );
}

/* ── voice master ───────────────────────────────────────────── */

function VoiceMasterView({ guildId }: { guildId: string }) {
  const channels = useApi<{ items: { id: string; channelId: string; ownerId: string; locked: boolean; createdAt: string }[] }>(`/guilds/${guildId}/voice-master`);
  return (
    <div className="space-y-5">
      <Card className="card-pad">
        <h2 className="mb-3 text-base font-semibold text-white">Active temporary channels</h2>
        {channels.loading ? (
          <CardSkeleton rows={3} />
        ) : channels.data?.items.length ? (
          <div className="table-wrap">
            <table className="w-full">
              <thead className="bg-white/[0.02]">
                <tr>
                  <th className="th">Channel</th>
                  <th className="th">Owner</th>
                  <th className="th">Locked</th>
                  <th className="th">Created</th>
                </tr>
              </thead>
              <tbody>
                {channels.data.items.map((channel) => (
                  <tr key={channel.id} className="row">
                    <td className="td font-mono text-xs">{channel.channelId}</td>
                    <td className="td font-mono text-xs">{channel.ownerId}</td>
                    <td className="td">{channel.locked ? 'yes' : 'no'}</td>
                    <td className="td">{formatDate(channel.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No temporary channels" description="They are created when a member joins the configured hub channel." />
        )}
      </Card>
      <SettingsForm moduleId="voicemaster" />
    </div>
  );
}

/* ── leveling ───────────────────────────────────────────────── */

function LevelingView({ guildId }: { guildId: string }) {
  const leaderboard = useApi<{ xp: { discordId: string; xp: number; level: number; messages: number }[]; voice: { discordId: string; voiceSeconds: number }[] }>(
    `/guilds/${guildId}/leveling/leaderboard`,
  );

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="card-pad">
          <h2 className="mb-3 text-base font-semibold text-white">XP leaderboard</h2>
          {leaderboard.loading ? <CardSkeleton rows={5} /> : <BarList items={(leaderboard.data?.xp ?? []).map((row) => ({ label: row.discordId, value: row.xp }))} />}
        </Card>
        <Card className="card-pad">
          <h2 className="mb-3 text-base font-semibold text-white">Voice activity</h2>
          {leaderboard.loading ? (
            <CardSkeleton rows={5} />
          ) : (
            <BarList items={(leaderboard.data?.voice ?? []).map((row) => ({ label: row.discordId, value: Math.round(row.voiceSeconds / 60) }))} />
          )}
        </Card>
      </div>

      <CrudManager
        title="Role rewards"
        path={`/guilds/${guildId}/leveling/rewards`}
        fields={[
          { key: 'level', label: 'Level', type: 'number', min: 1, max: 500, required: true, default: 5 },
          { key: 'roleId', label: 'Role', type: 'role', required: true },
          { key: 'removeOnLower', label: 'Remove when member drops below level', type: 'boolean', default: false },
        ]}
        columns={[
          { key: 'level', label: 'Level' },
          { key: 'roleId', label: 'Role', render: (item) => <span className="font-mono text-xs">{String(item.roleId)}</span> },
          { key: 'removeOnLower', label: 'Removable', render: (item) => (item.removeOnLower ? 'yes' : 'no') },
        ]}
        createLabel="Add reward"
        emptyTitle="No rewards configured"
      />
      <SettingsForm moduleId="leveling" />
    </div>
  );
}

/* ── statistics ─────────────────────────────────────────────── */

interface StatResponse {
  growth: { date: string; members: number; messages: number; joins: number; leaves: number }[];
  activity: { messages: number; joins: number; leaves: number; invites: number; tickets: number };
  xp: { discordId: string; xp: number }[];
  voice: { discordId: string; voiceSeconds: number }[];
}

function StatisticsView({ guildId }: { guildId: string }) {
  const stats = useApi<StatResponse>(`/guilds/${guildId}/stats?days=30`);
  const counters = useApi<{ items: { id: string; channelId: string; type: string; template: string; enabled: boolean }[] }>(`/guilds/${guildId}/counters`);
  const { push } = useToast();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (counters.data) setDraft(JSON.stringify(counters.data.items.map(({ channelId, type, template, enabled }) => ({ channelId, type, template, enabled })), null, 2));
  }, [counters.data]);

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Messages (7d)" value={formatNumber(stats.data?.activity.messages ?? 0)} />
        <StatCard label="Joins (7d)" value={formatNumber(stats.data?.activity.joins ?? 0)} />
        <StatCard label="Leaves (7d)" value={formatNumber(stats.data?.activity.leaves ?? 0)} />
        <StatCard label="Invites (7d)" value={formatNumber(stats.data?.activity.invites ?? 0)} />
      </div>

      <Card className="card-pad">
        <h2 className="mb-3 text-base font-semibold text-white">Members over 30 days</h2>
        {stats.loading ? (
          <CardSkeleton rows={6} />
        ) : (
          <LineChart data={(stats.data?.growth ?? []).map((point) => ({ label: point.date, value: point.members }))} />
        )}
      </Card>

      <Card className="card-pad">
        <h2 className="text-base font-semibold text-white">Counter channels</h2>
        <p className="mt-1 text-sm text-slate-400">Replaces the full counter list. Types: members, online, boosts, messages, tickets, invites.</p>
        <textarea className="input mt-3 min-h-[140px] font-mono text-xs" value={draft} onChange={(event) => setDraft(event.target.value)} aria-label="Counters JSON" />
        <div className="mt-3">
          <Button
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const items = JSON.parse(draft);
                await api(`/guilds/${guildId}/counters`, { method: 'PUT', body: JSON.stringify({ items }) });
                push('Counters saved', 'success');
                counters.reload();
              } catch (cause) {
                push(cause instanceof Error ? cause.message : 'Invalid JSON', 'error');
              } finally {
                setBusy(false);
              }
            }}
          >
            Save counters
          </Button>
        </div>
      </Card>

      <SettingsForm moduleId="statistics" />
    </div>
  );
}

/* ── giveaways ──────────────────────────────────────────────── */

function GiveawaysView({ guildId }: { guildId: string }) {
  const { push } = useToast();
  const fields: CrudField[] = [
    { key: 'prize', label: 'Prize', type: 'text', required: true, default: '' },
    { key: 'description', label: 'Description', type: 'textarea', default: '' },
    { key: 'channelId', label: 'Channel', type: 'channel', required: true, channelTypes: ['text'] },
    { key: 'winnerCount', label: 'Winners', type: 'number', min: 1, max: 50, default: 1 },
    { key: 'durationMs', label: 'Duration', type: 'duration', default: 3_600_000, required: true },
    { key: 'requiredRoleIds', label: 'Required roles', type: 'roles', default: [] },
    { key: 'bonusRoleIds', label: 'Bonus roles', type: 'roles', default: [] },
    { key: 'minAccountAgeDays', label: 'Minimum account age (days)', type: 'number', min: 0, max: 365, default: 0 },
    { key: 'minServerAgeDays', label: 'Minimum server age (days)', type: 'number', min: 0, max: 365, default: 0 },
  ];

  const act = async (id: string, action: 'end' | 'pause' | 'reroll') => {
    try {
      await api(`/guilds/${guildId}/giveaways/${id}/${action}`, { method: 'POST', body: JSON.stringify({}) });
      push(`${action} queued`, 'success');
    } catch (cause) {
      push(cause instanceof Error ? cause.message : 'Failed', 'error');
    }
  };

  return (
    <div className="space-y-5">
      <CrudManager
        title="Giveaways"
        description="Giveaways survive restarts: entries and deadlines live in the database."
        path={`/guilds/${guildId}/giveaways`}
        fields={fields}
        columns={[
          { key: 'prize', label: 'Prize' },
          { key: 'status', label: 'Status', render: (item) => <Badge tone={item.status === 'running' ? 'success' : item.status === 'paused' ? 'warning' : 'default'}>{String(item.status)}</Badge> },
          { key: 'winnerCount', label: 'Winners' },
          { key: 'endsAt', label: 'Ends', render: (item) => formatDate(item.endsAt as string) },
        ]}
        createLabel="Create giveaway"
        rowActions={(item) => (
          <>
            {item.status === 'running' || item.status === 'paused' ? (
              <Button variant="secondary" className="px-2 py-1 text-xs" onClick={() => void act(String(item.id), 'pause')}>
                {item.status === 'paused' ? 'Resume' : 'Pause'}
              </Button>
            ) : null}
            {item.status === 'ended' ? (
              <Button variant="secondary" className="px-2 py-1 text-xs" onClick={() => void act(String(item.id), 'reroll')}>
                Reroll
              </Button>
            ) : (
              <Button variant="secondary" className="px-2 py-1 text-xs" onClick={() => void act(String(item.id), 'end')}>
                End
              </Button>
            )}
          </>
        )}
      />
      <SettingsForm moduleId="giveaways" />
    </div>
  );
}

/* ── invites ────────────────────────────────────────────────── */

function InvitesView({ guildId }: { guildId: string }) {
  const invites = useApi<{ leaderboard: { inviterId: string; joins: number; leaves: number }[]; activeInvites: number }>(`/guilds/${guildId}/invites`);
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Tracked invites" value={formatNumber(invites.data?.activeInvites ?? 0)} />
        <StatCard label="Inviters" value={formatNumber(invites.data?.leaderboard.length ?? 0)} />
        <StatCard label="Net joins" value={formatNumber(invites.data?.leaderboard.reduce((total, row) => total + row.joins - row.leaves, 0) ?? 0)} />
      </div>
      <Card className="card-pad">
        <h2 className="mb-3 text-base font-semibold text-white">Invite leaderboard</h2>
        {invites.loading ? (
          <CardSkeleton rows={5} />
        ) : invites.data?.leaderboard.length ? (
          <div className="table-wrap">
            <table className="w-full">
              <thead className="bg-white/[0.02]">
                <tr>
                  <th className="th">Inviter</th>
                  <th className="th">Joins</th>
                  <th className="th">Leaves</th>
                  <th className="th">Net</th>
                </tr>
              </thead>
              <tbody>
                {invites.data.leaderboard.map((row) => (
                  <tr key={row.inviterId} className="row">
                    <td className="td font-mono text-xs">{row.inviterId}</td>
                    <td className="td">{row.joins}</td>
                    <td className="td">{row.leaves}</td>
                    <td className="td">{row.joins - row.leaves}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No invites tracked yet" description="Invites are attributed on member join once the bot is online." />
        )}
      </Card>
      <SettingsForm moduleId="invites" />
    </div>
  );
}

/* ── feeds ──────────────────────────────────────────────────── */

function FeedsView({ guildId }: { guildId: string }) {
  const { push } = useToast();
  const fields: CrudField[] = [
    { key: 'url', label: 'Feed URL', type: 'text', required: true, placeholder: 'https://example.com/feed.xml' },
    { key: 'type', label: 'Type', type: 'select', options: ['rss', 'youtube', 'twitch', 'reddit'].map((value) => ({ value, label: value })), default: 'rss' },
    { key: 'label', label: 'Label', type: 'text', default: '' },
    { key: 'channelId', label: 'Channel', type: 'channel', required: true, channelTypes: ['text'] },
    { key: 'mentionRoleIds', label: 'Mention roles', type: 'roles', default: [] },
    { key: 'template', label: 'Message template', type: 'text', default: '' },
  ];

  return (
    <div className="space-y-5">
      <div className="flex justify-end">
        <Button
          variant="secondary"
          onClick={async () => {
            try {
              await api(`/guilds/${guildId}/feeds/check-all`, { method: 'POST', body: JSON.stringify({}) });
              push('Feed check queued', 'success');
            } catch (cause) {
              push(cause instanceof Error ? cause.message : 'Failed', 'error');
            }
          }}
        >
          Check all feeds now
        </Button>
      </div>
      <CrudManager
        title="Feeds"
        path={`/guilds/${guildId}/feeds`}
        fields={fields}
        columns={[
          { key: 'label', label: 'Label', render: (item) => String(item.label || item.url) },
          { key: 'type', label: 'Type' },
          { key: 'channelId', label: 'Channel', render: (item) => <span className="font-mono text-xs">{String(item.channelId)}</span> },
          { key: 'lastError', label: 'Last error', render: (item) => (item.lastError ? <span className="text-red-300">{String(item.lastError).slice(0, 40)}</span> : '—') },
        ]}
        createLabel="Add feed"
        rowActions={(item) => (
          <Button
            variant="secondary"
            className="px-2.5 py-1.5 text-xs"
            onClick={async () => {
              try {
                const result = await api<{ title?: string; entries?: unknown[] }>(`/guilds/${guildId}/feeds/${String(item.id)}/test`, { method: 'POST', body: JSON.stringify({}) });
                push(`Feed OK: ${result.title ?? 'untitled'} (${result.entries?.length ?? 0} entries)`, 'success');
              } catch (cause) {
                push(cause instanceof Error ? cause.message : 'Feed failed', 'error');
              }
            }}
          >
            Test
          </Button>
        )}
      />
      <SettingsForm moduleId="rss" />
    </div>
  );
}

/* ── announcements ──────────────────────────────────────────── */

function AnnouncementsView({ guildId }: { guildId: string }) {
  const { push } = useToast();
  const fields: CrudField[] = [
    { key: 'channelId', label: 'Channel', type: 'channel', required: true, channelTypes: ['text'] },
    { key: 'title', label: 'Title', type: 'text', default: '' },
    { key: 'body', label: 'Body', type: 'textarea', required: true, default: '' },
    { key: 'recurrence', label: 'Recurrence', type: 'select', options: ['once', 'hourly', 'daily', 'weekly', 'monthly'].map((value) => ({ value, label: value })), default: 'once' },
    { key: 'nextRunAt', label: 'First run (ISO date)', type: 'text', placeholder: '2026-01-01T18:00:00.000Z' },
    { key: 'mentionRoleIds', label: 'Mention roles', type: 'roles', default: [] },
    { key: 'enabled', label: 'Enabled', type: 'boolean', default: true },
  ];

  return (
    <div className="space-y-5">
      <CrudManager
        title="Announcements"
        path={`/guilds/${guildId}/announcements`}
        fields={fields}
        columns={[
          { key: 'title', label: 'Title', render: (item) => String(item.title || item.body).slice(0, 60) },
          { key: 'recurrence', label: 'Recurrence' },
          { key: 'nextRunAt', label: 'Next run', render: (item) => (item.nextRunAt ? formatDate(item.nextRunAt as string) : '—') },
          { key: 'enabled', label: 'Enabled', render: (item) => <Badge tone={item.enabled ? 'success' : 'default'}>{item.enabled ? 'yes' : 'no'}</Badge> },
        ]}
        createLabel="Create announcement"
        rowActions={(item) => (
          <Button
            variant="secondary"
            className="px-2.5 py-1.5 text-xs"
            onClick={async () => {
              try {
                await api(`/guilds/${guildId}/announcements/${String(item.id)}/send`, { method: 'POST', body: JSON.stringify({}) });
                push('Announcement sent', 'success');
              } catch (cause) {
                push(cause instanceof Error ? cause.message : 'Send failed', 'error');
              }
            }}
          >
            Send now
          </Button>
        )}
      />
      <SettingsForm moduleId="announcements" />
    </div>
  );
}

/* ── emojis ─────────────────────────────────────────────────── */

function EmojisView({ guildId }: { guildId: string }) {
  const { push } = useToast();
  const emojis = useApi<{ items: { id: string; name: string; animated: boolean; url?: string }[] }>(`/guilds/${guildId}/emojis`);
  return (
    <div className="space-y-5">
      <Card className="card-pad">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-white">Emoji library</h2>
            <p className="mt-1 text-sm text-slate-400">{formatNumber(emojis.data?.items.length ?? 0)} synced from Discord</p>
          </div>
          <div className="flex gap-2">
            <a className="btn-secondary" href={`/api/irh/guilds/${guildId}/emojis/export`} download>
              Export
            </a>
            <Button
              onClick={async () => {
                try {
                  await api(`/guilds/${guildId}/emojis/sync`, { method: 'POST', body: JSON.stringify({}) });
                  push('Emoji sync queued', 'success');
                  emojis.reload();
                } catch (cause) {
                  push(cause instanceof Error ? cause.message : 'Sync failed', 'error');
                }
              }}
            >
              Sync now
            </Button>
          </div>
        </div>
        {emojis.loading ? (
          <CardSkeleton rows={4} />
        ) : emojis.data?.items.length ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {emojis.data.items.map((emoji) => (
              <span key={emoji.id} className="badge">
                <span className="font-mono text-xs">:{emoji.name}:</span>
                {emoji.animated ? <span className="text-[10px] text-slate-500">animated</span> : null}
              </span>
            ))}
          </div>
        ) : (
          <div className="mt-4">
            <EmptyState title="No emojis synced" description="Run a sync while the bot is online." />
          </div>
        )}
      </Card>
      <SettingsForm moduleId="emojis" />
    </div>
  );
}

/* ── auto reactions ─────────────────────────────────────────── */

function AutoReactionsView({ guildId }: { guildId: string }) {
  return (
    <div className="space-y-5">
      <CrudManager
        title="Reaction rules"
        path={`/guilds/${guildId}/auto-reactions`}
        fields={[
          { key: 'triggerType', label: 'Trigger', type: 'select', options: [{ value: 'keyword', label: 'Keyword' }, { value: 'regex', label: 'Regex' }, { value: 'all', label: 'Every message' }], default: 'keyword' },
          { key: 'pattern', label: 'Pattern / keyword', type: 'text', default: '' },
          { key: 'emojis', label: 'Emojis', type: 'tags', default: [] },
          { key: 'channelIds', label: 'Limit to channels', type: 'channels', default: [] },
          { key: 'ignoreBots', label: 'Ignore bots', type: 'boolean', default: true },
        ]}
        columns={[
          { key: 'triggerType', label: 'Trigger' },
          { key: 'pattern', label: 'Pattern' },
          { key: 'emojis', label: 'Emojis', render: (item) => (Array.isArray(item.emojis) ? item.emojis.join(' ') : '—') },
          { key: 'enabled', label: 'Enabled', render: (item) => <Badge tone={item.enabled ? 'success' : 'default'}>{item.enabled ? 'yes' : 'no'}</Badge> },
        ]}
        createLabel="Add rule"
      />
      <SettingsForm moduleId="autoreactions" />
    </div>
  );
}

/* ── custom commands ────────────────────────────────────────── */

function CustomCommandsView({ guildId }: { guildId: string }) {
  return (
    <div className="space-y-5">
      <CrudManager
        title="Custom commands"
        description="Prefix commands handled by the bot. Variables: {user} {userTag} {userName} {userId} {server} {memberCount}."
        path={`/guilds/${guildId}/custom-commands`}
        fields={[
          { key: 'name', label: 'Name', type: 'text', required: true, default: '' },
          { key: 'description', label: 'Description', type: 'text', default: '' },
          { key: 'response', label: 'Response', type: 'textarea', required: true, default: '' },
          { key: 'allowedRoleIds', label: 'Allowed roles', type: 'roles', default: [] },
          { key: 'cooldownSec', label: 'Cooldown (seconds)', type: 'number', min: 0, max: 3600, default: 3 },
          { key: 'enabled', label: 'Enabled', type: 'boolean', default: true },
        ]}
        columns={[
          { key: 'name', label: 'Name' },
          { key: 'response', label: 'Response', render: (item) => <span className="block max-w-[320px] truncate">{String(item.response)}</span> },
          { key: 'uses', label: 'Uses' },
        ]}
        createLabel="Add command"
      />
      <CrudManager
        title="Auto responders"
        path={`/guilds/${guildId}/autoresponders`}
        fields={[
          { key: 'trigger', label: 'Trigger', type: 'text', required: true, default: '' },
          { key: 'matchType', label: 'Match', type: 'select', options: ['contains', 'exact', 'prefix'].map((value) => ({ value, label: value })), default: 'contains' },
          { key: 'response', label: 'Response', type: 'textarea', required: true, default: '' },
          { key: 'reply', label: 'Reply to the message', type: 'boolean', default: true },
          { key: 'enabled', label: 'Enabled', type: 'boolean', default: true },
        ]}
        columns={[
          { key: 'trigger', label: 'Trigger' },
          { key: 'matchType', label: 'Match' },
          { key: 'response', label: 'Response', render: (item) => <span className="block max-w-[320px] truncate">{String(item.response)}</span> },
        ]}
        createLabel="Add responder"
      />
      <SettingsForm moduleId="customcommands" />
    </div>
  );
}

/* ── automations ────────────────────────────────────────────── */

function AutomationsView({ guildId }: { guildId: string }) {
  const { push } = useToast();
  return (
    <div className="space-y-5">
      <CrudManager
        title="Workflows"
        path={`/guilds/${guildId}/automations`}
        fields={[
          { key: 'name', label: 'Name', type: 'text', required: true, default: '' },
          {
            key: 'trigger',
            label: 'Trigger',
            type: 'select',
            options: ['member.join', 'member.leave', 'message.create', 'ticket.create', 'level.up', 'reaction.add'].map((value) => ({ value, label: value })),
            default: 'member.join',
          },
          { key: 'conditions', label: 'Conditions (JSON)', type: 'json', description: '[{ field, operator, value }]', default: [] },
          { key: 'actions', label: 'Actions (JSON)', type: 'json', description: '[{ type, value, durationMs }]', default: [] },
          { key: 'enabled', label: 'Enabled', type: 'boolean', default: true },
        ]}
        columns={[
          { key: 'name', label: 'Name' },
          { key: 'trigger', label: 'Trigger' },
          { key: 'actions', label: 'Actions', render: (item) => `${Array.isArray(item.actions) ? item.actions.length : 0}` },
          { key: 'enabled', label: 'Enabled', render: (item) => <Badge tone={item.enabled ? 'success' : 'default'}>{item.enabled ? 'yes' : 'no'}</Badge> },
        ]}
        createLabel="Create workflow"
        rowActions={(item) => (
          <Button
            variant="secondary"
            className="px-2.5 py-1.5 text-xs"
            onClick={async () => {
              try {
                await api(`/guilds/${guildId}/automations/${String(item.id)}/run`, { method: 'POST', body: JSON.stringify({}) });
                push('Test run queued', 'success');
              } catch (cause) {
                push(cause instanceof Error ? cause.message : 'Failed', 'error');
              }
            }}
          >
            Test
          </Button>
        )}
      />
      <SettingsForm moduleId="automations" />
    </div>
  );
}

/* ── integrations ───────────────────────────────────────────── */

function IntegrationsView({ guildId }: { guildId: string }) {
  const { push } = useToast();
  const list = useApi<{ items: { id: string; provider: string; status: string; scope: string; updatedAt: string }[]; env: { youtubeApiKey: boolean; twitch: boolean } }>(
    `/guilds/${guildId}/integrations`,
  );
  const [provider, setProvider] = useState('youtube');
  const [secrets, setSecrets] = useState('{\n  "apiKey": ""\n}');
  const [busy, setBusy] = useState(false);

  return (
    <div className="space-y-5">
      <Card className="card-pad">
        <h2 className="text-base font-semibold text-white">Environment credentials</h2>
        <p className="mt-1 text-sm text-slate-400">Server-wide keys from the environment. Values are never sent to the browser.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Badge tone={list.data?.env.youtubeApiKey ? 'success' : 'default'}>YOUTUBE_API_KEY {list.data?.env.youtubeApiKey ? 'set' : 'missing'}</Badge>
          <Badge tone={list.data?.env.twitch ? 'success' : 'default'}>TWITCH_CLIENT_ID / SECRET {list.data?.env.twitch ? 'set' : 'missing'}</Badge>
        </div>
      </Card>

      <Card className="card-pad">
        <h2 className="text-base font-semibold text-white">Per-server credentials</h2>
        <p className="mt-1 text-sm text-slate-400">Encrypted at rest with AES-256-GCM. Requires ENCRYPTION_KEY on the API.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-[180px_1fr_auto] sm:items-start">
          <select className="input" value={provider} onChange={(event) => setProvider(event.target.value)} aria-label="Provider">
            {['youtube', 'twitch', 'reddit', 'webhook'].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <textarea className="input min-h-[96px] font-mono text-xs" value={secrets} onChange={(event) => setSecrets(event.target.value)} aria-label="Secrets JSON" />
          <Button
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const parsed = JSON.parse(secrets);
                await api(`/guilds/${guildId}/integrations/${provider}`, { method: 'PUT', body: JSON.stringify({ secrets: parsed }) });
                push('Credentials stored', 'success');
                list.reload();
              } catch (cause) {
                push(cause instanceof Error ? cause.message : 'Invalid JSON', 'error');
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </Button>
        </div>

        <div className="mt-4 space-y-2">
          {list.data?.items.length ? (
            list.data.items.map((item) => (
              <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-slate-200">{item.provider}</span>
                  <Badge tone={item.status === 'configured' ? 'success' : 'warning'}>{item.status}</Badge>
                  <Badge>{item.scope}</Badge>
                  <span className="text-xs text-slate-500">{formatDate(item.updatedAt)}</span>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    className="px-2 py-1 text-xs"
                    onClick={async () => {
                      try {
                        await api(`/guilds/${guildId}/integrations/${item.provider}/verify`, { method: 'POST', body: JSON.stringify({}) });
                        push('Credentials verified', 'success');
                      } catch (cause) {
                        push(cause instanceof Error ? cause.message : 'Verification failed', 'error');
                      }
                    }}
                  >
                    Verify
                  </Button>
                  <Button
                    variant="danger"
                    className="px-2 py-1 text-xs"
                    onClick={async () => {
                      await api(`/guilds/${guildId}/integrations/${item.provider}`, { method: 'DELETE' }).catch(() => undefined);
                      list.reload();
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))
          ) : (
            <p className="text-xs text-slate-500">No per-server credentials stored yet.</p>
          )}
        </div>
      </Card>
      <SettingsForm moduleId="integrations" />
    </div>
  );
}

/* ── audit ──────────────────────────────────────────────────── */

function AuditView({ guildId }: { guildId: string }) {
  const audit = useApi<{ items: { id: string; action: string; actorType: string; actorId: string | null; targetType: string | null; targetId: string | null; createdAt: string }[]; total: number }>(
    `/guilds/${guildId}/audit?page=1&pageSize=25`,
  );
  return (
    <div className="space-y-5">
      <Card className="card-pad">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-white">Configuration & action history</h2>
          <div className="flex gap-2">
            <a className="btn-secondary text-xs" href={`/api/irh/guilds/${guildId}/logs/export?days=30`} download>
              Export log CSV
            </a>
            <Badge>{formatNumber(audit.data?.total ?? 0)} entries</Badge>
          </div>
        </div>
        {audit.loading ? (
          <CardSkeleton rows={6} />
        ) : audit.data?.items.length ? (
          <div className="table-wrap">
            <table className="w-full">
              <thead className="bg-white/[0.02]">
                <tr>
                  <th className="th">Action</th>
                  <th className="th">Actor</th>
                  <th className="th">Target</th>
                  <th className="th">When</th>
                </tr>
              </thead>
              <tbody>
                {audit.data.items.map((row) => (
                  <tr key={row.id} className="row">
                    <td className="td">{row.action}</td>
                    <td className="td font-mono text-xs">
                      {row.actorType}
                      {row.actorId ? ` · ${row.actorId}` : ''}
                    </td>
                    <td className="td font-mono text-xs">
                      {row.targetType ?? '—'}
                      {row.targetId ? ` · ${row.targetId}` : ''}
                    </td>
                    <td className="td">{formatDate(row.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No audit entries yet" />
        )}
      </Card>
    </div>
  );
}

/* ── backups ────────────────────────────────────────────────── */

function BackupsView({ guildId }: { guildId: string }) {
  const backups = useApi<{ items: { id: string; label: string | null; sizeBytes: number; createdAt: string }[] }>(`/guilds/${guildId}/backups`);
  const { push } = useToast();
  const [busy, setBusy] = useState(false);

  return (
    <div className="space-y-5">
      <Card className="card-pad">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-white">Configuration backups</h2>
            <p className="mt-1 text-sm text-slate-400">Snapshots include module settings, panels, commands and feeds.</p>
          </div>
          <Button
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api(`/guilds/${guildId}/backups`, { method: 'POST', body: JSON.stringify({ label: `Manual ${new Date().toISOString().slice(0, 16)}` }) });
                push('Backup created', 'success');
                backups.reload();
              } catch (cause) {
                push(cause instanceof Error ? cause.message : 'Backup failed', 'error');
              } finally {
                setBusy(false);
              }
            }}
          >
            Create backup
          </Button>
        </div>
        <div className="mt-4">
          {backups.loading ? (
            <CardSkeleton rows={3} />
          ) : backups.data?.items.length ? (
            <div className="table-wrap">
              <table className="w-full">
                <thead className="bg-white/[0.02]">
                  <tr>
                    <th className="th">Label</th>
                    <th className="th">Size</th>
                    <th className="th">Created</th>
                    <th className="th" />
                  </tr>
                </thead>
                <tbody>
                  {backups.data.items.map((backup) => (
                    <tr key={backup.id} className="row">
                      <td className="td">{backup.label ?? 'Untitled'}</td>
                      <td className="td">{Math.max(1, Math.round(backup.sizeBytes / 1024))} KB</td>
                      <td className="td">{formatDate(backup.createdAt)}</td>
                      <td className="td text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="secondary"
                            className="px-2 py-1 text-xs"
                            onClick={async () => {
                              if (!window.confirm('Restore this backup? Current settings will be replaced.')) return;
                              try {
                                await api(`/guilds/${guildId}/backups/${backup.id}/restore`, { method: 'POST', body: JSON.stringify({}) });
                                push('Backup restored', 'success');
                              } catch (cause) {
                                push(cause instanceof Error ? cause.message : 'Restore failed', 'error');
                              }
                            }}
                          >
                            Restore
                          </Button>
                          <Button
                            variant="danger"
                            className="px-2 py-1 text-xs"
                            onClick={async () => {
                              await api(`/guilds/${guildId}/backups/${backup.id}`, { method: 'DELETE' }).catch(() => undefined);
                              backups.reload();
                            }}
                          >
                            Delete
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="No backups yet" />
          )}
        </div>
      </Card>
      <SettingsForm moduleId="backups" />
    </div>
  );
}

/* ── status & system ────────────────────────────────────────── */

function JsonPanel({ path, title, description }: { path: string; title: string; description?: string }) {
  const data = useApi<Record<string, unknown>>(path);
  return (
    <Card className="card-pad">
      <h2 className="text-base font-semibold text-white">{title}</h2>
      {description ? <p className="mt-1 text-sm text-slate-400">{description}</p> : null}
      {data.loading ? (
        <div className="mt-3">
          <CardSkeleton rows={4} />
        </div>
      ) : data.error ? (
        <div className="mt-3">
          <Alert tone="error">{data.error}</Alert>
        </div>
      ) : (
        <pre className="mt-3 max-h-80 overflow-auto rounded-xl border border-white/5 bg-ink-900/70 p-3 font-mono text-[11px] leading-relaxed text-slate-300">
          {JSON.stringify(data.data, null, 2)}
        </pre>
      )}
    </Card>
  );
}

function StatusView() {
  return (
    <div className="space-y-5">
      <JsonPanel path="/system/status" title="Bot & realtime status" description="Heartbeat age, gateway state and connected dashboards." />
      <JsonPanel path="/system/events" title="Recent system events" description="Heartbeats and error events written by the services." />
    </div>
  );
}

function SystemView() {
  const jobs = useApi<{ items: { id: string; type: string; status: string; attempts: number; runAt: string; lastError: string | null }[] }>('/system/jobs');
  const { push } = useToast();
  return (
    <div className="space-y-5">
      <JsonPanel path="/system/health" title="Health check" description="Database connectivity, queue driver and job statistics." />
      <Card className="card-pad">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">Job queue</h2>
          <Button variant="secondary" onClick={() => jobs.reload()}>
            Refresh
          </Button>
        </div>
        {jobs.loading ? (
          <CardSkeleton rows={4} />
        ) : jobs.data?.items.length ? (
          <div className="table-wrap">
            <table className="w-full">
              <thead className="bg-white/[0.02]">
                <tr>
                  <th className="th">Type</th>
                  <th className="th">Status</th>
                  <th className="th">Attempts</th>
                  <th className="th">Run at</th>
                  <th className="th" />
                </tr>
              </thead>
              <tbody>
                {jobs.data.items.map((job) => (
                  <tr key={job.id} className="row">
                    <td className="td">{job.type}</td>
                    <td className="td">
                      <Badge tone={job.status === 'failed' ? 'danger' : job.status === 'pending' ? 'info' : 'success'}>{job.status}</Badge>
                    </td>
                    <td className="td">{job.attempts}</td>
                    <td className="td">{formatDate(job.runAt)}</td>
                    <td className="td text-right">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="secondary"
                          className="px-2 py-1 text-xs"
                          onClick={async () => {
                            try {
                              await api(`/system/jobs/${job.id}/retry`, { method: 'POST', body: JSON.stringify({}) });
                              push('Job queued for retry', 'success');
                              jobs.reload();
                            } catch (cause) {
                              push(cause instanceof Error ? cause.message : 'Retry failed', 'error');
                            }
                          }}
                        >
                          Retry
                        </Button>
                        <Button
                          variant="danger"
                          className="px-2 py-1 text-xs"
                          onClick={async () => {
                            await api(`/system/jobs/${job.id}`, { method: 'DELETE' }).catch(() => undefined);
                            jobs.reload();
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="Queue is empty" description="Scheduled work appears here with its next run time." />
        )}
      </Card>
    </div>
  );
}
