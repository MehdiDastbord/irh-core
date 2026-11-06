# Deployment

IRH CORE runs three processes against one database:

| Process | Command | Port |
| --- | --- | --- |
| API | `npm run start:api` | `4000` |
| Bot | `npm run start:bot` | — |
| Dashboard | `npm run start:web` (after `npm run build`) | `3000` |

Only the dashboard and API need to be reachable from the internet (the API can stay on loopback because Next.js proxies `/api/irh/*`).

## 1. PostgreSQL

Create a database and a dedicated user:

```sql
CREATE ROLE irh LOGIN PASSWORD 'strong-password';
CREATE DATABASE irh OWNER irh;
```

Set `DATABASE_URL=postgresql://irh:strong-password@127.0.0.1:5432/irh`, then apply the canonical PostgreSQL schema:

```bash
npx prisma generate --schema prisma/schema.prisma
npx prisma migrate deploy --schema prisma/schema.prisma   # if migrations are present
# or, for a first deployment without migration history:
npx prisma db push --schema prisma/schema.prisma
```

`scripts/db-provider.mjs` is only for SQLite development. Production always uses `prisma/schema.prisma` with the PostgreSQL provider.

## 2. Redis (optional)

Set `REDIS_URL=redis://127.0.0.1:6379`. Redis drives the BullMQ tick that processes the durable `ScheduledJob` queue faster; without it the bot polls the same table, so scheduled work still runs after a restart. Redis **never** holds the only copy of a job.

## 3. Environment

Copy `.env.example` to `.env` on the server and fill in every required value. `.env` must never be committed. Generate secrets with:

```bash
openssl rand -hex 32   # SESSION_SECRET
openssl rand -hex 32   # ENCRYPTION_KEY (must be 64 hex characters)
```

Set `APP_ORIGIN=https://core.example.com` and add exactly `https://core.example.com/api/irh/auth/callback` to the Discord application's OAuth2 redirects. Cookies are marked `Secure` automatically when `NODE_ENV=production`; terminate TLS at a reverse proxy.

## 4. Docker Compose

```bash
cp .env.example .env      # fill in
export POSTGRES_PASSWORD='strong-password'
docker compose up -d --build
docker compose logs -f api bot web
```

Services: `postgres`, `redis`, `api`, `bot`, `web`. The image runs `prisma generate` during build, so the API and bot share the generated PostgreSQL client.

## 5. Manual (systemd / PM2)

```bash
npm ci
npx prisma generate --schema prisma/schema.prisma
npm run build -w @irh/web
npm run start:api   # separate service
npm run start:bot   # separate service
npm run start:web   # separate service
```

For a single supervised process tree (recommended on a small VPS or inside a container), use:

```bash
npm run start:all
```

`scripts/supervisor.mjs` starts the API and dashboard, starts the bot only when `DISCORD_BOT_TOKEN` is present, restarts crashed services with exponential backoff, and forwards `SIGTERM`/`SIGINT` so Prisma disconnects cleanly. Set `API_PORT` and `WEB_PORT` to change ports.

Example systemd unit (repeat for api/bot/web):

```ini
[Unit]
Description=IRH CORE API
After=network.target postgresql.service

[Service]
WorkingDirectory=/opt/irh-core
EnvironmentFile=/opt/irh-core/.env
ExecStart=/usr/bin/npm run start:api
Restart=always
RestartSec=5
User=irh

[Install]
WantedBy=multi-user.target
```

## 6. Reverse proxy (nginx)

```nginx
server {
  listen 443 ssl http2;
  server_name core.example.com;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  # Optional: expose the API directly for the WebSocket endpoint.
  location /ws {
    proxy_pass http://127.0.0.1:4000/ws;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
```

If the dashboard is served from a different host than the API, set `NEXT_PUBLIC_WS_URL=wss://api.example.com/ws`.

## 7. First run checklist

1. Start the API and check `GET /api/system/health`.
2. Invite the bot and confirm `botPresent` becomes true in the dashboard.
3. Open **Logging** and route a few events to a channel; trigger one (delete a message) and verify delivery plus a row in **Audit History → Export log CSV**.
4. Open **Tickets**, create a panel and post it. Open a ticket and close it; confirm the transcript is stored.
5. Create a giveaway and restart the bot; verify it still ends on time.
6. Create a backup and restore it from **Backups**.
7. Sign in with a second Discord account that cannot manage the server and confirm it cannot see the guild.

## 8. Backups and retention

- `Prisma` data: use `pg_dump -Fc irh > irh-$(date +%F).dump` nightly.
- In-app: **Backups** snapshots module settings, panels, rewards, commands and counters; `POST /api/guilds/:id/backups/retention` purges old snapshots.
- Logs: configure retention under **Logging** (default 90 days) and run `POST /api/guilds/:id/logs/purge`.
- Heartbeats older than one hour are deleted automatically by the bot.

## 9. Monitoring

- `GET /api/system/health` — database, queue driver and job counts.
- `GET /api/system/status` — gateway heartbeat age, guild count, realtime clients.
- Structured JSON logs from every process include guild and event context; secrets are redacted by `packages/db/src/logger.ts`.
- Point an uptime monitor at `/health` and at the dashboard.

## 10. Scaling

- The API is stateless; run several replicas behind the proxy. WebSocket tickets are HMAC-signed with `SESSION_SECRET`, so any replica can accept them (broadcasts are per-process — use one replica for realtime or add sticky sessions).
- Run exactly one bot process per token unless you shard with discord.js `Shards`.
- The job queue is safe with multiple workers thanks to atomic claiming; set `WORKER_ID` per process.

## 11. Security checklist

- [ ] `SESSION_SECRET` and `ENCRYPTION_KEY` are unique, stored only in `.env`/secret manager.
- [ ] `NODE_ENV=production` so cookies are `Secure`.
- [ ] TLS terminated; HSTS enabled at the proxy.
- [ ] `APP_ORIGIN` matches the public dashboard exactly (CSRF + OAuth redirect).
- [ ] Discord bot token rotated if it was ever pasted into chat or committed.
- [ ] Database reachable only from the application host.
- [ ] Dashboard access limited to users with Administrator/Manage Server (enforced server-side per request).
- [ ] Audit log retention understood; exports contain user IDs.

## 12. Known deployment limitations

- Discord does not deliver message content for messages sent before the bot started; the logging engine records `*(unavailable)*`.
- Voice Master cannot transfer ownership of a channel the bot cannot move; it records the failure instead of faking success.
- Welcome cards render text only (no avatar compositing).
- YouTube API quotas apply when `YOUTUBE_API_KEY` is configured; otherwise the public RSS feed is used.
- Realtime broadcasts are per-process; multi-replica deployments need sticky sessions or a single realtime replica.
