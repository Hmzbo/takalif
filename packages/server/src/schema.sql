-- MyWeeklies schema
-- Single-user by design: no users, no teams, no auth tables.
--
-- Tables are STRICT so SQLite refuses to store a TEXT value in an INTEGER
-- column. That matters: a lookback_days of 'abc' would otherwise persist and
-- break every subsequent request.

CREATE TABLE IF NOT EXISTS settings (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  timezone       TEXT    NOT NULL DEFAULT 'UTC',
  day_rollover   TEXT    NOT NULL DEFAULT '04:00',
  lookback_days  INTEGER NOT NULL DEFAULT 30  CHECK (lookback_days  BETWEEN 0 AND 3660),
  lookahead_days INTEGER NOT NULL DEFAULT 14  CHECK (lookahead_days BETWEEN 0 AND 3660),
  email          TEXT
) STRICT;

INSERT OR IGNORE INTO settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS rules (
  id           TEXT    PRIMARY KEY,
  title        TEXT    NOT NULL,
  description  TEXT,
  rrule        TEXT    NOT NULL,
  dtstart_date TEXT    NOT NULL,
  due_time     TEXT,
  created_date TEXT    NOT NULL,
  track_streak INTEGER NOT NULL DEFAULT 0 CHECK (track_streak IN (0, 1)),
  category     TEXT,
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at   TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_rules_active ON rules (active);

CREATE TABLE IF NOT EXISTS rule_versions (
  id             TEXT    PRIMARY KEY,
  rule_id        TEXT    NOT NULL REFERENCES rules (id) ON DELETE CASCADE,
  version        INTEGER NOT NULL,
  rrule          TEXT    NOT NULL,
  dtstart_date   TEXT    NOT NULL,
  effective_from TEXT    NOT NULL,
  created_at     TEXT    NOT NULL,
  UNIQUE (rule_id, version)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_versions_rule ON rule_versions (rule_id, effective_from);

-- The ledger. `scheduled_date` is a local civil date, never a UTC instant.
CREATE TABLE IF NOT EXISTS occurrences (
  id             TEXT    PRIMARY KEY,
  rule_id        TEXT    NOT NULL REFERENCES rules (id) ON DELETE CASCADE,
  rule_version   INTEGER NOT NULL,
  scheduled_date TEXT    NOT NULL,
  due_time       TEXT,
  status         TEXT    NOT NULL CHECK (status IN ('pending', 'done', 'missed', 'skipped')),
  completed_at   TEXT,
  note           TEXT,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL,
  UNIQUE (rule_id, scheduled_date)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_occ_date ON occurrences (scheduled_date);
CREATE INDEX IF NOT EXISTS idx_occ_rule_status ON occurrences (rule_id, status);

CREATE TABLE IF NOT EXISTS skip_periods (
  id         TEXT PRIMARY KEY,
  start_date TEXT NOT NULL,
  end_date   TEXT NOT NULL,
  reason     TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_skip_range ON skip_periods (start_date, end_date);

CREATE TABLE IF NOT EXISTS exceptions (
  id      TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES rules (id) ON DELETE CASCADE,
  date    TEXT NOT NULL,
  UNIQUE (rule_id, date)
) STRICT;

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
