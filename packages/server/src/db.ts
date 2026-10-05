import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Locate `schema.sql` whether we are running from `src` (tsx, dev) or from
 * `dist` (compiled, Docker). Keeping this resilient avoids a fragile
 * asset-copy step in the build.
 */
function findSchema(): string {
  const candidates = [join(here, 'schema.sql'), join(here, '..', 'src', 'schema.sql')];
  for (const path of candidates) {
    if (existsSync(path)) return readFileSync(path, 'utf8');
  }
  throw new Error(`schema.sql not found. Looked in:\n  ${candidates.join('\n  ')}`);
}

export type DB = Database.Database;

interface Migration {
  version: number;
  description: string;
  up: (db: DB) => void;
}

function columnExists(db: DB, table: string, column: string): boolean {
  // Table names are hardcoded below, never user input.
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

function ensureColumn(db: DB, table: string, column: string, ddl: string): void {
  if (!columnExists(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'reminder columns: rules.reminder_time, occurrences.reminded_at, settings.ntfy_*',
    up(db) {
      ensureColumn(db, 'rules', 'reminder_time', 'TEXT');
      ensureColumn(db, 'occurrences', 'reminded_at', 'TEXT');
      ensureColumn(db, 'settings', 'ntfy_topic', 'TEXT');
      ensureColumn(db, 'settings', 'ntfy_server', 'TEXT');
    },
  },
];

/** Latest schema version. Bump when appending to MIGRATIONS. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Bring an existing database up to the current schema.
 *
 * Idempotent by construction: each step checks for the column first, because
 * a fresh database created from the current schema.sql already has it while an
 * older one does not. `user_version` records progress so a crash mid-migration
 * resumes rather than restarting.
 */
export function migrate(db: DB): void {
  const current = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    m.up(db);
    db.pragma(`user_version = ${m.version}`);
  }
}

export function openDatabase(file: string): DB {
  const db = new Database(file);
  // WAL keeps reads from blocking the writes that a check-off performs.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(findSchema());
  migrate(db);
  return db;
}
