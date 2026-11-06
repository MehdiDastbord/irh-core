#!/usr/bin/env bash
# IRH CORE — one-shot setup for a free 24/7 Linux host.
#
# Tested target: Ubuntu 22.04 / 24.04 on Oracle Cloud "Always Free" (Ampere A1,
# arm64) or Google Cloud free e2-micro, but any x86-64/arm64 VPS works.
#
#   sudo APP_ORIGIN=https://irh.example.com bash deploy/vm/install.sh
#
# The script installs Node 22, clones/updates the app, installs dependencies,
# generates the Prisma client, builds the dashboard and registers a systemd
# service that keeps the bot, API and dashboard running across reboots.
# It never starts the service with an empty configuration: edit .env first.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/MehdiDastbord/irh-core.git}"
APP_DIR="${APP_DIR:-/opt/irh-core}"
APP_USER="${APP_USER:-irh}"
NODE_MAJOR="${NODE_MAJOR:-22}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script with sudo." >&2
  exit 1
fi

echo "== packages =="
apt-get update -qq
apt-get install -y -qq ca-certificates curl git openssl build-essential

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "== node ${NODE_MAJOR} =="
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
fi
echo "node $(node -v) / npm $(npm -v)"

echo "== service user =="
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"

echo "== source =="
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$APP_DIR"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "== dependencies =="
sudo -u "$APP_USER" env HOME="/home/$APP_USER" bash -c "cd '$APP_DIR' && npm ci"

echo "== prisma client =="
sudo -u "$APP_USER" env HOME="/home/$APP_USER" bash -c "cd '$APP_DIR' && npm run db:generate"

echo "== dashboard build =="
sudo -u "$APP_USER" env HOME="/home/$APP_USER" bash -c "cd '$APP_DIR' && npm run build -w @irh/web"

echo "== configuration =="
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "Created $APP_DIR/.env from .env.example."
fi
if [ -n "${APP_ORIGIN:-}" ]; then
  sed -i "s|^APP_ORIGIN=.*|APP_ORIGIN=${APP_ORIGIN}|" "$APP_DIR/.env"
fi
sed -i "s|^NODE_ENV=.*|NODE_ENV=production|" "$APP_DIR/.env"

echo "== systemd =="
install -m 0644 "$APP_DIR/deploy/vm/irh-core.service" /etc/systemd/system/irh-core.service
systemctl daemon-reload
systemctl enable irh-core >/dev/null

cat <<EOF

IRH CORE is installed but NOT started yet — fill in the secrets first:

  1. sudo nano $APP_DIR/.env
       SESSION_SECRET, ENCRYPTION_KEY   (generate: openssl rand -hex 32)
       DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN
       APP_ORIGIN=$APP_DIR public URL (default: http://<server-ip>:3000)
       leave DATABASE_URL empty to use the local SQLite file (fine on a VM)

  2. sudo -u $APP_USER bash -c "cd $APP_DIR && set -a && . ./.env && set +a && npm run db:push"

  3. sudo systemctl start irh-core
     sudo systemctl status irh-core
     journalctl -u irh-core -f

Dashboard is served on port 3000. For a free HTTPS URL, put a Cloudflare
Tunnel in front of it (see docs/DEPLOYMENT.md section 14).
EOF
