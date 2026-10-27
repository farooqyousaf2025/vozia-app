#!/usr/bin/env node
/**
 * Applies the schema, then any not-yet-applied versioned migration, to DATABASE_URL.
 * No `psql` binary needed — everything goes over `pg`.
 *
 *   node scripts/migrate.cjs            apply
 *   node scripts/migrate.cjs --status   list applied/pending without touching anything
 *   node scripts/migrate.cjs --force    re-checksum edited migrations instead of failing
 *
 * Two layers, on purpose:
 *
 *  1. `database/schema.sql` is the *baseline*: `CREATE TABLE IF NOT EXISTS` everywhere, so
 *     a fresh install gets the whole shape in one pass and an existing database is left
 *     alone. It is frozen history — new DDL does not go here.
 *  2. `database/migrations/NNNN_name.sql` is the delta log. Each file runs exactly once per
 *     database, inside its own transaction, and is recorded in `schema_migrations` with a
 *     sha256 of its bytes. That is what makes "apply the update" safe on a server that has
 *     user data in it: nothing is dropped, nothing is re-run, and an edited file that was
 *     already applied is reported instead of silently trusted.
 *
 * Never write a migration that destroys data. A column that must go is dropped in a later,
 * separately reviewed release after the code stopped reading it.
 *
 * One PostgreSQL rule worth knowing before adding a file: `ALTER TYPE ... ADD VALUE` is
 * allowed inside this transaction, but the new value cannot be *used* by the same file.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const SCHEMA_PATH = path.join(ROOT, 'database', 'schema.sql');
const MIGRATIONS_DIR = path.join(ROOT, 'database', 'migrations');
const connectionString = process.env.DATABASE_URL || 'postgres://voiza:voiza@localhost:5432/voiza';

const argv = process.argv.slice(2);
const STATUS_ONLY = argv.includes('--status');
const FORCE = argv.includes('--force');

/** Bootstrap table: created by the runner, never by a migration, so v1 databases adopt cleanly. */
const ENSURE_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    name       TEXT         NOT NULL,
    checksum   TEXT         NOT NULL,
    applied_at TIMESTAMPTZ  NOT NULL DEFAULT now()
  )`;

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);

function migrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_[A-Za-z0-9_-]+\.sql$/.test(f))
    .sort()
    .map((file) => ({
      version: file.slice(0, 4),
      file,
      path: path.join(MIGRATIONS_DIR, file),
      sql: fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'),
      checksum: sha256(fs.readFileSync(path.join(MIGRATIONS_DIR, file))),
    }));
}

(async () => {
  const files = migrationFiles();
  const client = new Client({ connectionString, connectionTimeoutMillis: 10_000 });
  await client.connect();

  if (STATUS_ONLY) {
    await client.query(ENSURE_TABLE);
    const applied = await client.query('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version');
    const known = new Set(applied.rows.map((r) => r.version));
    console.log(`schema_migrations: ${applied.rows.length} applied`);
    for (const r of applied.rows) console.log(`  ${r.version}  ${r.name}  (${r.checksum})  ${r.applied_at.toISOString()}`);
    const pending = files.filter((f) => !known.has(f.version));
    console.log(`pending: ${pending.length}`);
    for (const f of pending) console.log(`  ${f.version}  ${f.file}`);
    await client.end();
    return;
  }

  // ---- baseline ----------------------------------------------------------------
  await client.query(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  console.log(`[migrate] baseline applied (${path.relative(ROOT, SCHEMA_PATH)})`);
  await client.query(ENSURE_TABLE);

  // ---- deltas ------------------------------------------------------------------
  const applied = await client.query('SELECT version, name, checksum FROM schema_migrations');
  const byVersion = new Map(applied.rows.map((r) => [r.version, r]));
  let ran = 0;

  for (const m of files) {
    const prior = byVersion.get(m.version);
    if (prior) {
      if (prior.checksum !== m.checksum) {
        const detail = `applied as ${prior.checksum}, file now ${m.checksum}`;
        if (!FORCE) {
          await client.end();
          throw new Error(
            `${m.file} is already recorded (${detail}). An applied migration must not be edited — ` +
              `add a new one, or re-accept the file deliberately with --force.`,
          );
        }
        console.warn(`[migrate] WARN re-accepting edited ${m.file} (${detail})`);
        await client.query('UPDATE schema_migrations SET checksum = $2 WHERE version = $1', [m.version, m.checksum]);
      }
      continue;
    }

    const started = Date.now();
    try {
      await client.query('BEGIN');
      await client.query(m.sql);
      await client.query(
        'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
        [m.version, m.file, m.checksum],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
      throw new Error(`${m.file} failed and was rolled back: ${err.message}`);
    }
    ran += 1;
    console.log(`[migrate] applied ${m.file} (${m.checksum}) in ${Date.now() - started} ms`);
  }

  // Informational: the columns the room-effect and like features depend on.
  const cols = await client.query(
    'select table_name, column_name from information_schema.columns ' +
      "where table_name in ('gifts', 'rooms') and column_name in ('effect_kind', 'like_count') order by 1, 2",
  );
  for (const r of cols.rows) console.log(`[migrate]   present: ${r.table_name}.${r.column_name}`);
  const gameTables = await client.query(
    'select count(*)::int n from pg_tables where schemaname = current_schema() and tablename like $1',
    ['game_%'],
  );
  console.log(
    `[migrate] done — ${ran} migration(s) applied this run, ${gameTables.rows[0].n} game table(s) present, ` +
      `${files.length} total in ${path.relative(ROOT, MIGRATIONS_DIR) || 'database/migrations'}`,
  );
  await client.end();
})().catch((err) => {
  console.error('[migrate] FAILED', err.message);
  process.exitCode = 1;
});
