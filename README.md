# IRH CORE

One Discord bot, one dashboard, one backend, one database — replacing the functionality of Carl Bot, Sapphire, Dyno, ProBot, Wick, Security, Voice Master, Ticket Tools, Stats, Server Stats, Readybot.io, MonitorRSS, Luna, Xneon, Full Logs Bot, Invite Tracker, Emotly, Honey Pot, Arcane, Guild Tag, Announce, Ping Sync, Auto Reacter, Noctaly and Giveaway Bot with original code.

IRH CORE is a TypeScript monorepo:

| Package | Purpose |
| --- | --- |
| `packages/shared` | Types, module registry, Zod validation, permissions, logging catalogue, feed parser |
| `packages/db` | Prisma client, settings, moderation, tickets, jobs, backups, crypto, stats |
| `apps/api` | Fastify REST API, OAuth2 sessions, WebSockets, Discord REST actions |
| `apps/bot` | discord.js gateway bot: modules, handlers, slash commands, job scheduler |
| `apps/web` | Next.js dashboard (27 pages, dark theme, real data) |

## Feature modules

- **Moderation** — ban/kick/timeout/warn, case numbering, warnings history, escalation, temp punishments, purge, slowmode, lock/unlock, nickname, notes, appeals, stats, hierarchy validation.
- **AutoMod** — spam, flood, mentions, links, invites, bad words, caps, duplicates, configurable punishments, exemptions, Discord AutoMod sync.
- **Security** — anti-nuke, anti-raid, anti-alt, webhook abuse, mass ban/kick, channel/role deletion, permission abuse, suspicious admins, honeypots, trusted users, emergency lockdown, incidents, audit-log correlation.
- **Logging engine** — 80+ gateway events, per-event enable/disable, multiple channels, colours, executor/target/reason/before-after, searchable history, ignore lists, CSV export, retention.
- **Welcome & verification** — embeds, DMs, generated PNG welcome cards, autoroles, button roles, reaction roles, select roles, captcha/rules verification, account-age checks.
- **Invite tracker** — attribution, inviter, fake invites, leaves, leaderboard, rewards.
- **Tickets** — unlimited panels, custom forms, claim/transfer, priorities, HTML transcripts, ratings, auto-close, persistent state.
- **Voice Master** — join-to-create, rename/lock/hide/limit/claim/permit, automatic deletion, voice stats.
- **Leveling & stats** — XP, levels, rank cards, leaderboards, role rewards, message/voice stats, growth charts, counter channels.
- **Giveaways** — multiple winners, requirements, bonus entries, pause/resume, reroll, persistence.
- **Feeds** — RSS/Atom, YouTube, Twitch, Reddit, dedupe, multiple destinations, SSRF protection.
- **Announcements, custom commands, autoresponders, auto reactions, workflows, emoji/sticker manager, backups, audit trail.**

## Requirements

- Node.js ≥ 20.11 (tested on Node 26)
- PostgreSQL 14+ for production (SQLite is supported for local development)
- Redis 6+ (optional — enables the BullMQ tick driver; the database queue works without it)
- A Discord application with a bot token

## Quick start

```bash
npm install                 # install every workspace
cp .env.example .env        # then fill in the values below
npm run db:push             # generates the Prisma client + creates the schema
npm run dev                 # api (4000) + bot + dashboard (3000)
```

Open http://localhost:3000 and sign in with Discord.

### Required environment variables

| Variable | Purpose |
| --- | --- |
| `DISCORD_CLIENT_ID` | OAuth2 client id |
| `DISCORD_CLIENT_SECRET` | OAuth2 client secret |
| `DISCORD_BOT_TOKEN` | Bot token (bot process) |
| `DISCORD_REDIRECT_URI` | Must match the Discord app, default `http://localhost:3000/api/irh/auth/callback` |
| `DATABASE_URL` | `postgresql://user:pass@host:5432/irh` or `file:./dev.db` |
| `SESSION_SECRET` | ≥ 32 random characters, signs OAuth state and WS tickets |
| `ENCRYPTION_KEY` | 64 hex characters, encrypts OAuth tokens and integration credentials |
| `APP_ORIGIN` | Public dashboard origin, e.g. `https://core.example.com` |
| `API_URL` | Where Next.js proxies `/api/irh/*`, default `http://127.0.0.1:4000` |
| `REDIS_URL` | Optional, enables the BullMQ tick driver |
| `DISCORD_DEV_GUILD_ID` | Optional, registers commands instantly in one guild |
| `BOT_OWNER_IDS` | Comma-separated Discord user ids for owner-only commands |

Optional integrations: `YOUTUBE_API_KEY`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`. Per-server credentials are stored encrypted through **Dashboard → Integrations**.

### Discord application setup

1. Create an application at https://discord.com/developers/applications.
2. **Bot** → reset/copy the token into `DISCORD_BOT_TOKEN`.
3. **OAuth2** → add `${APP_ORIGIN}/api/irh/auth/callback` as a redirect.
4. Invite with scopes `bot applications.commands` and the permissions the features need (Manage Server, Manage Roles, Manage Channels, Ban/Kick, Moderate Members, Manage Messages, View Audit Log, Manage Webhooks, Manage Emojis, Read Message History, Connect, Move Members).
5. Put the bot role **above** every role it must assign.

## Commands

`/help` `/setup` `/dashboard` `/config` `/mod` `/warn` `/ban` `/kick` `/timeout` `/purge` `/lock` `/unlock` `/ticket` `/giveaway` `/rank` `/leaderboard` `/stats` `/invites` `/poll` `/embed` `/announce` `/emoji` `/sticker` `/backup` `/logs` `/ping`

Administrative commands verify Discord permissions **and** IRH hierarchy before acting. Advanced configuration lives on the dashboard.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | API, bot and dashboard with hot reload |
| `npm run dev:api` / `dev:bot` / `dev:web` | Run one service |
| `npm run db:push` | Generate a client and push the schema (SQLite locally via `scripts/db-provider.mjs`) |
| `npm run db:migrate` | Create a PostgreSQL migration (production schema) |
| `npm run db:migrate:deploy` | Apply migrations in production |
| `npm run db:seed` | Connectivity check / optional demo (never writes fake statistics) |
| `npm test` | Reset the test database and run Vitest |
| `npm run typecheck` | TypeScript across every package |
| `npm run lint` | ESLint |
| `npm run verify` | typecheck + lint + tests |
| `npm run build` | Production dashboard build |
| `npm start` | API + bot + built dashboard (concurrently) |
| `npm run start:all` | Supervised API + dashboard + bot with restart/backoff — use this for 24/7 hosting |

## Architecture notes

- **One settings pipeline.** `packages/shared/src/modules.ts` defines every module field; it drives Zod validation, defaults, bot feature gates and dashboard forms. Adding a field makes it configurable everywhere.
- **Durable queue.** `ScheduledJob` in the database is the source of truth (claim → run → complete/fail with exponential backoff). Redis/BullMQ is an optional driver that ticks the same queue, so no job is lost without Redis.
- **Logging split.** Gateway handling (`handlers/logging.ts`) and audit-log correlation (`lib/logging.ts` + `handlers/security.ts`) are separate. Missing audit entries produce `null`, never invented executors.
- **Auth.** OAuth2 code flow, opaque session tokens (only SHA-256 hashes stored), Discord tokens AES-256-GCM encrypted, double-submit CSRF cookie + Origin check, short-lived HMAC WebSocket tickets.
- **Guild isolation.** Every query is scoped by the internal guild id resolved from the authenticated user's accessible guilds.

## Testing

Unit and integration tests cover shared utilities/validation/logging catalogue/feed SSRF, database settings isolation, escalation, jobs with backoff, crypto, backup/restore, API authorization and CSRF, and bot detection/image/eligibility logic. Run `npm test`.

Live Discord verification (login, gateway events, real command execution) requires credentials and is documented in `docs/DEPLOYMENT.md`.

## Limitations

- Discord does not expose message content for messages sent before the bot started or without the Message Content intent; logs record `*(unavailable)*` rather than fabricating content.
- Welcome cards use a built-in bitmap font and do not composite avatars.
- Twitch notifications use the public Helix API; YouTube feeds use the public channel RSS feed unless `YOUTUBE_API_KEY` is set.
- Discord AutoMod is synced where supported; IRH's own filters still run for full control.
- Bulk message imports, voice audio, and Discord's premium features are out of scope by design.

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for production deployment, backups, monitoring and the security checklist.
