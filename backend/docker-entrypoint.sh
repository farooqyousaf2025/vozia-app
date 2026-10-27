#!/bin/sh
set -e

if [ -n "$DATABASE_URL" ]; then
  echo "[voiza] applying database schema"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=0 -f /app/database/schema.sql >/dev/null 2>&1 \
    || echo "[voiza] schema apply skipped (already present or db not ready)"
  if [ "$SEED_DEMO_DATA" = "1" ]; then
    echo "[voiza] applying demo seed"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=0 -f /app/database/seed.sql >/dev/null 2>&1 || true
  fi
fi

exec "$@"
