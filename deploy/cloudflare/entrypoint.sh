#!/bin/sh
# IRH CORE container entrypoint.
#
# 1. Applies the PostgreSQL schema when a postgres:// DATABASE_URL is present
#    (idempotent `prisma db push`, so a fresh database is usable immediately).
# 2. Hands over to the supervisor, which owns api + dashboard + bot and
#    restarts any of them that crash.
set -eu

cd /app

if [ -n "${DATABASE_URL:-}" ]; then
  case "$DATABASE_URL" in
    postgres*)
      echo "[entrypoint] applying PostgreSQL schema"
      node scripts/db-provider.mjs --push
      ;;
    *)
      echo "[entrypoint] non-PostgreSQL DATABASE_URL — skipping schema push (SQLite data is ephemeral inside a container)"
      ;;
  esac
fi

exec npm run start:all
