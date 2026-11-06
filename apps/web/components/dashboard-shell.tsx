'use client';

import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { SECTION_GROUPS, SECTIONS } from '@/lib/sections';
import { Button, CardSkeleton, Spinner } from './ui';

interface GuildItem {
  id: string;
  name: string;
  icon: string | null;
  botPresent: boolean;
  accessLevel: string;
}

interface MeResponse {
  user?: { discordId?: string; id?: string; username?: string; globalName?: string | null; avatar?: string | null };
  session?: { expiresAt?: string };
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const params = useParams<{ guildId?: string }>();
  const activeGuild = params?.guildId;

  const [user, setUser] = useState<MeResponse['user'] | null>(null);
  const [guilds, setGuilds] = useState<GuildItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api<MeResponse>('/me'), api<{ items: GuildItem[] }>('/guilds')])
      .then(([me, list]) => {
        if (cancelled) return;
        setUser(me.user ?? null);
        setGuilds(list.items);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof ApiError && cause.status === 401) {
          router.replace('/');
          return;
        }
        setError(cause instanceof Error ? cause.message : 'Could not load your profile');
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  const currentGuild = useMemo(() => guilds?.find((guild) => guild.id === activeGuild) ?? null, [guilds, activeGuild]);

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      window.location.href = '/';
    }
  }, []);

  if (error) {
    return (
      <div className="grid min-h-screen place-items-center px-6">
        <div className="card card-pad max-w-md text-center">
          <p className="text-sm font-semibold text-red-300">{error}</p>
          <Button className="mt-4" onClick={() => window.location.reload()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (!guilds || !user) {
    return (
      <div className="grid min-h-screen place-items-center">
        <div className="flex items-center gap-3 text-sm text-slate-400">
          <Spinner /> Loading IRH CORE…
        </div>
      </div>
    );
  }

  const grouped = SECTION_GROUPS.map((group) => ({ group, sections: SECTIONS.filter((section) => section.group === group) }));
  const displayName = user.globalName || user.username || 'Signed in';

  return (
    <div className="flex min-h-screen">
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-72 transform border-r border-white/5 bg-ink-900/95 backdrop-blur transition-transform lg:static lg:translate-x-0 ${
          menuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        aria-label="Dashboard navigation"
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between px-5 py-5">
            <Link href="/dashboard" className="flex items-center gap-2.5">
              <span className="grid h-9 w-9 place-items-center rounded-lg bg-brand-gradient text-xs font-bold text-white">IRH</span>
              <span>
                <span className="block text-sm font-semibold text-white">IRH CORE</span>
                <span className="block text-[10px] uppercase tracking-wider text-slate-500">Control panel</span>
              </span>
            </Link>
            <button type="button" className="btn-ghost px-2 py-1 lg:hidden" onClick={() => setMenuOpen(false)} aria-label="Close menu">
              ✕
            </button>
          </div>

          <div className="px-4">
            <label htmlFor="guild-switcher" className="label">
              Server
            </label>
            <select
              id="guild-switcher"
              className="input"
              value={currentGuild?.id ?? ''}
              onChange={(event) => {
                const target = event.target.value;
                if (target) router.push(`/dashboard/g/${target}`);
              }}
            >
              <option value="">Select a server…</option>
              {guilds.map((guild) => (
                <option key={guild.id} value={guild.id}>
                  {guild.name}
                  {guild.botPresent ? '' : ' (bot not added)'}
                </option>
              ))}
            </select>
          </div>

          <nav className="mt-5 flex-1 space-y-4 overflow-y-auto px-3 pb-4">
            {grouped.map(({ group, sections }) => (
              <div key={group}>
                <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-600">{group}</p>
                <div className="space-y-0.5">
                  {sections.map((section) => {
                    if (!activeGuild) {
                      return (
                        <span key={section.id} className="nav-link cursor-not-allowed opacity-40" title="Select a server first">
                          <span className="w-4 text-center text-xs">{section.icon}</span>
                          {section.label}
                        </span>
                      );
                    }
                    const href = section.id === 'overview' ? `/dashboard/g/${activeGuild}` : `/dashboard/g/${activeGuild}/${section.id}`;
                    const active = section.id === 'overview' ? pathname === `/dashboard/g/${activeGuild}` : pathname === href;
                    return (
                      <Link key={section.id} href={href} className={`nav-link ${active ? 'nav-link-active' : ''}`} aria-current={active ? 'page' : undefined}>
                        <span className="w-4 text-center text-xs">{section.icon}</span>
                        <span className="truncate">{section.label}</span>
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>

          <div className="border-t border-white/5 p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium text-slate-200">{displayName}</p>
                <p className="truncate text-[11px] text-slate-500">{user.discordId ?? user.id}</p>
              </div>
              <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={() => void logout()}>
                Sign out
              </Button>
            </div>
          </div>
        </div>
      </aside>

      {menuOpen ? <button type="button" aria-label="Close navigation" className="fixed inset-0 z-30 bg-black/60 lg:hidden" onClick={() => setMenuOpen(false)} /> : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-white/5 bg-ink-950/80 px-4 py-3 backdrop-blur sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button type="button" className="btn-ghost px-2 py-1 lg:hidden" onClick={() => setMenuOpen(true)} aria-label="Open menu">
              ☰
            </button>
            {currentGuild ? (
              <div className="flex min-w-0 items-center gap-2.5">
                {currentGuild.icon ? (
                  <img src={`https://cdn.discordapp.com/icons/${currentGuild.id}/${currentGuild.icon}.png?size=64`} alt="" className="h-8 w-8 rounded-lg" />
                ) : (
                  <span className="grid h-8 w-8 place-items-center rounded-lg bg-ink-700 text-xs font-semibold text-slate-300">{currentGuild.name.slice(0, 2)}</span>
                )}
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-white">{currentGuild.name}</p>
                  <p className="text-[11px] text-slate-500">{currentGuild.botPresent ? 'Bot connected' : 'Bot not invited to this server'}</p>
                </div>
              </div>
            ) : (
              <p className="text-sm font-semibold text-white">Dashboard</p>
            )}
          </div>
          {currentGuild && !currentGuild.botPresent ? (
            <a
              className="btn-secondary text-xs"
              href={`https://discord.com/oauth2/authorize?client_id=${process.env.NEXT_PUBLIC_DISCORD_CLIENT_ID ?? ''}&scope=bot%20applications.commands&permissions=1515487984887&guild_id=${currentGuild.id}`}
              target="_blank"
              rel="noreferrer"
            >
              Invite bot
            </a>
          ) : (
            <span className="badge hidden sm:inline-flex">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Live configuration
            </span>
          )}
        </header>

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">{guilds.length === 0 ? <NoServers /> : children}</main>
      </div>
    </div>
  );
}

function NoServers() {
  return (
    <div className="mx-auto max-w-xl">
      <div className="card card-pad text-center">
        <h2 className="text-lg font-semibold text-white">No manageable servers found</h2>
        <p className="mt-2 text-sm text-slate-400">
          IRH CORE only shows servers where you have <strong>Administrator</strong> or <strong>Manage Server</strong>. If you own a server, sign in again and
          make sure IRH CORE was invited with the <code>applications.commands</code> scope.
        </p>
        <div className="mt-5 flex justify-center gap-2">
          <a className="btn-primary" href="/api/irh/auth/login">
            Refresh Discord access
          </a>
        </div>
      </div>
    </div>
  );
}

export function DashboardSkeleton() {
  return <CardSkeleton rows={6} />;
}
