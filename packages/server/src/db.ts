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

export function openDatabase(file: string): DB {
  const db = new Database(file);
  // WAL keeps reads from blocking the writes that a check-off performs.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(findSchema());
  return db;
}
