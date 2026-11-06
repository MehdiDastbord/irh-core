import Link from 'next/link';

const FEATURES = [
  { title: 'Moderation', body: 'Cases, warnings, escalation, appeals, temporary punishments and hierarchy-safe actions.' },
  { title: 'AutoMod & Security', body: 'Spam, raid, alt and nuke protection with audit-log correlation and graduated responses.' },
  { title: 'Complete Logging', body: 'Every gateway event, routed to one or many channels, searchable and exportable.' },
  { title: 'Tickets', body: 'Unlimited panels, custom forms, claims, priorities, HTML transcripts and ratings.' },
  { title: 'Community', body: 'Welcome images, verification, autoroles, reaction roles and Voice Master channels.' },
  { title: 'Engagement', body: 'Leveling, rank cards, giveaways, invite tracking and milestone rewards.' },
  { title: 'Automation', body: 'RSS, YouTube and Reddit feeds, announcements, custom commands and workflows.' },
  { title: 'One Dashboard', body: '27 pages of real configuration backed by the same database the bot uses.' },
];

export default function LandingPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col px-5 py-6 sm:px-8">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand-gradient text-sm font-bold text-white shadow-glow">IRH</span>
          <div>
            <p className="text-sm font-semibold tracking-tight text-white">IRH CORE</p>
            <p className="text-[11px] text-slate-500">Discord management platform</p>
          </div>
        </div>
        <nav className="flex items-center gap-2">
          <Link href="/dashboard" className="btn-secondary">
            Dashboard
          </Link>
          <a href="/api/irh/auth/login" className="btn-primary">
            Sign in with Discord
          </a>
        </nav>
      </header>

      <section className="flex flex-1 flex-col items-center justify-center py-16 text-center sm:py-24">
        <span className="badge mb-5">One bot · One dashboard · One database</span>
        <h1 className="max-w-4xl text-balance text-4xl font-semibold leading-[1.1] tracking-tight text-white sm:text-6xl">
          The all-in-one Discord platform that replaces{' '}
          <span className="bg-brand-gradient bg-clip-text text-transparent">twenty-four bots</span>
        </h1>
        <p className="mt-5 max-w-2xl text-pretty text-base leading-relaxed text-slate-400 sm:text-lg">
          Moderation, automod, anti-nuke security, a complete logging engine, tickets, Voice Master, leveling, giveaways, invite tracking, feeds and
          automations — configurable from one professional dashboard with real data.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <a href="/api/irh/auth/login" className="btn-primary px-6 py-3 text-base">
            Manage your servers
          </a>
          <Link href="/dashboard" className="btn-secondary px-6 py-3 text-base">
            Open dashboard
          </Link>
        </div>
        <p className="mt-4 text-xs text-slate-500">OAuth2 sign-in · only servers you can manage are shown · no data is fabricated</p>

        <div className="mt-16 grid w-full gap-3 text-left sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="card card-pad">
              <p className="text-sm font-semibold text-white">{feature.title}</p>
              <p className="mt-1.5 text-[13px] leading-relaxed text-slate-400">{feature.body}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="flex flex-col items-center justify-between gap-2 border-t border-white/5 py-5 text-xs text-slate-500 sm:flex-row">
        <p>IRH CORE · self-hosted Discord management</p>
        <p>Built with discord.js, Fastify, PostgreSQL and Next.js</p>
      </footer>
    </main>
  );
}
