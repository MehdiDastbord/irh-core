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

## 13. Cloudflare Containers (no server of your own)

> This path requires the **Workers Paid** plan ($5/month plus usage). For a
> zero-cost deployment, see section 14.

Cloudflare Workers cannot host the bot: the Discord gateway is a long-lived
WebSocket and Workers requests are short-lived. Cloudflare Containers runs the
same image (`Dockerfile`) in Cloudflare's network instead, with this Worker as
the public entry point:

- `cloudflare/worker.ts` — one container instance (`IrhCoreContainer`), every
  request proxied to the dashboard on port 3000; a `*/5 * * * *` cron pings
  `/api/irh/system/health` so the gateway connection is not dropped between
  dashboard visits.
- `wrangler.jsonc` — container definition, Durable Object export and cron.
- `deploy/cloudflare/entrypoint.sh` — applies the PostgreSQL schema on boot,
  then hands over to `scripts/supervisor.mjs` (api + dashboard + bot).

### Requirements

- Workers **Paid** plan ($5/month). Containers are not available on the free plan.
- A **PostgreSQL** database reachable over the internet: SQLite inside a
  container is wiped on every restart. Use Neon, Aiven, or your own server.
- Docker running locally — `wrangler deploy` builds and pushes the image.
- `linux/amd64` image (Apple Silicon and ARM machines included).

### Steps

```bash
npx wrangler login                 # or: npm run cf:login

npx wrangler secret put DATABASE_URL        # postgresql://user:pass@host/db?sslmode=require
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ENCRYPTION_KEY
npx wrangler secret put DISCORD_CLIENT_ID
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put DISCORD_DEV_GUILD_ID # optional
npx wrangler secret put BOT_OWNER_IDS        # optional

npx wrangler deploy                # or: npm run cf:deploy
```

`wrangler deploy` prints the public URL, for example
`https://irh-core.<subdomain>.workers.dev`. Set it as `APP_ORIGIN` and redeploy
so OAuth redirects and CSRF checks match the deployment:

```bash
npx wrangler secret put APP_ORIGIN   # https://irh-core.<subdomain>.workers.dev
npx wrangler deploy
```

In the Discord developer portal add `<APP_ORIGIN>/api/irh/auth/callback` as a
redirect URI before signing in.

### Cost

`instance_type = "basic"` (1/4 vCPU, 1 GiB, 4 GB disk) running 24/7 uses about
730 GiB-hours of the 25 GiB-hours included in Workers Paid, so expect roughly
$10-12/month plus egress in total. `max_instances = 1` keeps a single instance.
Drop `instance_type` to `lite` or let the container sleep by removing the cron
trigger if you want costs near the $5 base.

### Verify

```bash
npx wrangler tail                   # live logs from the Worker and container
curl https://irh-core.<subdomain>.workers.dev/api/irh/system/health
```

A `database:false` value means `DATABASE_URL` is wrong or unreachable; the
container stays up and the dashboard still renders.

### Limitations

- Long-running CPU work and large memory use cost more; the bot is I/O bound so
  `basic` is sufficient for a few hundred servers.
- Container instances can restart during a Cloudflare rollout; the supervisor
  reconnects the bot automatically, and Drizzle/Prisma state lives in Postgres.
- Uploads/backups written to the container filesystem are lost on restart.

## 14. Free 24/7 hosting

Everything here costs nothing per month. The bot needs a long-lived process, so
it has to run on a machine that stays on — but that machine does not have to be
yours, and it does not have to cost money.

| Option | Cost | Keeps the bot online? | Notes |
| --- | --- | --- | --- |
| Oracle Cloud **Always Free** (Ampere A1, 4 OCPU / 24 GB on arm64) | $0 | Yes | Best fit. Card for identity verification only; instances are not charged. |
| Google Cloud free **e2-micro** (us-central1/1/us-west1) | $0 | Yes | 1 vCPU / 1 GB — enough for the bot, dashboard and SQLite. |
| Your own PC + Cloudflare Tunnel | $0 | Only while the PC is on | Easiest, but not "without my PC". |
| Cloudflare Containers (§13) | $5+/month | Yes | Only if you later want zero servers to manage. |

A public GitHub repo, GitHub Actions CI, Cloudflare DNS and Cloudflare Tunnel
are all free as well. What is *not* free and cannot be made free: a Discord bot
token (free), a Cloudflare **Containers** deployment (paid), and managed
PostgreSQL (free tiers exist, but a VM keeps its own SQLite file at $0).

### Step 1 — create the free VM

Oracle Cloud: *Compute → Instances → Create*, shape **VM.Standard.A1.Flex**
(Always Free eligible), image **Ubuntu 24.04**, add your SSH key, open ingress
to TCP 22 (and 3000 if you want direct access before adding a tunnel).

Google Cloud: create an **e2-micro** in a free-tier region with Ubuntu 24.04 and
the same firewall rule.

### Step 2 — install IRH CORE

```bash
ssh ubuntu@<server-ip>
sudo apt-get update && sudo apt-get install -y git
sudo git clone https://github.com/<you>/irh-core.git /opt/irh-core
cd /opt/irh-core
sudo APP_ORIGIN=http://<server-ip>:3000 bash deploy/vm/install.sh
```

The script installs Node 22, runs `npm ci`, generates the Prisma client, builds
the dashboard and registers `irh-core.service` with systemd (`Restart=always`,
ostarts on boot). It deliberately does not start the service yet.

### Step 3 — configure and start

```bash
sudo nano /opt/irh-core/.env      # SESSION_SECRET, ENCRYPTION_KEY, Discord credentials
openssl rand -hex 32              # SESSION_SECRET
openssl rand -hex 32              # ENCRYPTION_KEY

sudo -u irh bash -c 'cd /opt/irh-core && set -a && . ./.env && set +a && npm run db:push'
sudo systemctl start irh-core
sudo systemctl status irh-core
journalctl -u irh-core -f
```

Leave `DATABASE_URL` empty for SQLite (`file:./irh-core.db` inside `/opt/irh-core`,
persisted on the VM disk). Use PostgreSQL only if you already run one.

### Step 4 — free HTTPS with Cloudflare Tunnel

```bash
# on the VM
curl -fsSL https://pkg.cloudflare.com/cloudflared/install.sh | sudo bash
cloudflared tunnel login                 # authorises your free Cloudflare account
cloudflared tunnel create irh-core
cloudflared tunnel route dns irh-core irh.example.com
sudo cloudflared service install         # runs as a systemd service, starts on boot
```

Point the tunnel at `http://localhost:3000` (add
`--url http://localhost:3000` when creating, or edit the generated
`/etc/cloudflared/config.yml`), then set `APP_ORIGIN=https://irh.example.com` in
`.env` and `sudo systemctl restart irh-core`. Add
`https://irh.example.com/api/irh/auth/callback` as the Discord redirect URI.

No domain yet? `cloudflared tunnel --url http://localhost:3000` prints a free
`*.trycloudflare.com` URL, but that URL changes on every restart.

### Operating it

```bash
sudo systemctl restart irh-core          # apply .env changes
sudo systemctl stop irh-core
git -C /opt/irh-core pull && sudo -u irh bash -c \
  'cd /opt/irh-core && npm ci && npm run db:generate && npm run build -w @irh/web'
sudo systemctl restart irh-core          # after an update
```

Back up the SQLite file while the service is stopped, or point
`DATABASE_URL` at `pg_dump`-able PostgreSQL:

```bash
sudo systemctl stop irh-core
sudo cp /opt/irh-core/irh-core.db /var/backups/irh-core-$(date +%F).db
sudo systemctl start irh-core
```

### Free-tier caveats

- Oracle reclaims Always Free instances that stay idle on the *paid* shapes; keep
the instance busy enough (the bot's gateway connection counts) or start it from
the console if it is ever stopped.
- Free tiers have no SLA and can be capacity-limited at signup; retry another
  region/availability domain if the shape is unavailable.
- ARM64 (Oracle A1) is supported: Prisma ships a `linux-arm64` engine and the
  image/build above is pure Node.
- One bot process per token — never run the VM service and a local copy with the
  same `DISCORD_BOT_TOKEN` at the same time.
