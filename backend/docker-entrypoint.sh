#!/bin/sh
set -e

# Schema first, always. `migrate.cjs` applies database/schema.sql (CREATE TABLE IF NOT
# EXISTS everywhere, so it is a no-op on an existing volume) and then every file in
# database/migrations/ that this database has not already recorded in schema_migrations.
# Running the plain schema here instead would leave a re-deployed container missing the
# tables the code reads at boot — a room_themes lookup fails on the first room DTO, which
# is a crash loop with no mention of migrations in the log.
#
# A failed migration exits the container rather than starting an API that cannot serve
# rooms: `restart: unless-stopped` retries, and the reason is the last line in the log.
if [ -n "$DATABASE_URL" ]; then
  echo "[voiza] applying schema + pending migrations"
  node /app/scripts/migrate.cjs
fi

if [ "$SEED_DEMO_DATA" = "1" ]; then
  echo "[voiza] applying demo seed"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=0 -f /app/database/seed.sql >/dev/null 2>&1 || true
fi

exec "$@"
