import { randomUUID } from 'node:crypto';
import {
  addDays,
  buildReport,
  DEFAULT_SETTINGS,
  GREGORIAN,
  generatePlan,
  isKnownCalendar,
  safeWindowDays,
  todayInTimeZone,
  zonedTimeToUtc,
  type Exception,
  type GeneratorPlan,
  type Occurrence,
  type PeriodReport,
  type Rule,
  type RuleVersion,
  type Settings,
  type SkipPeriod,
} from '@takalif/core';
import type { DB } from './db.js';

const nowIso = (): string => new Date().toISOString();
const newId = (): string => randomUUID();

// ---------------------------------------------------------------------------
// Row shapes (SQLite speaks snake_case; the domain speaks camelCase)
// ---------------------------------------------------------------------------

interface SettingsRow {
  timezone: string;
  day_rollover: string;
  lookback_days: number;
  lookahead_days: number;
  default_calendar: string | null;
  email: string | null;
  ntfy_topic: string | null;
  ntfy_server: string | null;
}

interface RuleRow {
  id: string;
  title: string;
  description: string | null;
  rrule: string;
  dtstart_date: string;
  due_time: string | null;
  calendar: string | null;
  reminder_time: string | null;
  created_date: string;
  track_streak: number;
  category: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  id: string;
  rule_id: string;
  version: number;
  rrule: string;
  dtstart_date: string;
  effective_from: string;
  created_at: string;
}

interface OccurrenceRow {
  id: string;
  rule_id: string;
  rule_version: number;
  scheduled_date: string;
  due_time: string | null;
  status: Occurrence['status'];
  completed_at: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

interface SkipRow {
  id: string;
  start_date: string;
  end_date: string;
  reason: string | null;
  created_at: string;
}

interface ExceptionRow {
  id: string;
  rule_id: string;
  date: string;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

const toSettings = (r: SettingsRow): Settings => ({
  timezone: r.timezone,
  dayRollover: r.day_rollover,
  lookbackDays: r.lookback_days,
  lookaheadDays: r.lookahead_days,
  defaultCalendar: isKnownCalendar(r.default_calendar)
    ? r.default_calendar
    : DEFAULT_SETTINGS.defaultCalendar,
  email: r.email,
  ntfyTopic: r.ntfy_topic,
  ntfyServer: r.ntfy_server,
});

const toRule = (r: RuleRow): Rule => ({
  id: r.id,
  title: r.title,
  description: r.description,
  rrule: r.rrule,
  dtstartDate: r.dtstart_date,
  dueTime: r.due_time,
  calendar: isKnownCalendar(r.calendar) ? r.calendar : GREGORIAN,
  reminderTime: r.reminder_time,
  createdDate: r.created_date,
  trackStreak: r.track_streak === 1,
  category: r.category,
  active: r.active === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toVersion = (r: VersionRow): RuleVersion => ({
  id: r.id,
  ruleId: r.rule_id,
  version: r.version,
  rrule: r.rrule,
  dtstartDate: r.dtstart_date,
  effectiveFrom: r.effective_from,
  createdAt: r.created_at,
});

const toOccurrence = (r: OccurrenceRow): Occurrence => ({
  id: r.id,
  ruleId: r.rule_id,
  ruleVersion: r.rule_version,
  scheduledDate: r.scheduled_date,
  dueTime: r.due_time,
  status: r.status,
  completedAt: r.completed_at,
  note: r.note,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toSkip = (r: SkipRow): SkipPeriod => ({
  id: r.id,
  startDate: r.start_date,
  endDate: r.end_date,
  reason: r.reason,
  createdAt: r.created_at,
});

const toException = (r: ExceptionRow): Exception => ({
  id: r.id,
  ruleId: r.rule_id,
  date: r.date,
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function readSettings(db: DB): Settings {
  const row = db.prepare('SELECT * FROM settings WHERE id = 1').get() as
    | SettingsRow
    | undefined;
  return row ? toSettings(row) : { ...DEFAULT_SETTINGS };
}

export function readRules(db: DB, includeArchived = false): Rule[] {
  const sql = includeArchived
    ? 'SELECT * FROM rules ORDER BY active DESC, title COLLATE NOCASE'
    : 'SELECT * FROM rules WHERE active = 1 ORDER BY title COLLATE NOCASE';
  return (db.prepare(sql).all() as RuleRow[]).map(toRule);
}

export function readVersions(db: DB): RuleVersion[] {
  return (db.prepare('SELECT * FROM rule_versions ORDER BY rule_id, version').all() as VersionRow[]).map(
    toVersion,
  );
}

export function readOccurrences(db: DB, from: string, to: string): Occurrence[] {
  const rows = db
    .prepare(
      'SELECT * FROM occurrences WHERE scheduled_date BETWEEN ? AND ? ORDER BY scheduled_date, rule_id',
    )
    .all(from, to) as OccurrenceRow[];
  return rows.map(toOccurrence);
}

export function readSkipPeriods(db: DB): SkipPeriod[] {
  return (db.prepare('SELECT * FROM skip_periods ORDER BY start_date').all() as SkipRow[]).map(toSkip);
}

export function readExceptions(db: DB): Exception[] {
  return (db.prepare('SELECT * FROM exceptions').all() as ExceptionRow[]).map(toException);
}

// ---------------------------------------------------------------------------
// The generator, applied to SQLite
// ---------------------------------------------------------------------------

/**
 * Run the generator and persist its plan in a single transaction.
 *
 * The plan is computed from committed state and applied atomically, so a
 * reader never observes a half-materialised window.
 */
export function materialize(db: DB, now: Date = new Date()): GeneratorPlan {
  const settings = readSettings(db);
  const rules = readRules(db);
  const versions = readVersions(db);
  const skipPeriods = readSkipPeriods(db);
  const exceptions = readExceptions(db);

  // A superset of the window, so reconciliation can see rows just outside it.
  const pad = 1;
  const today = todayInTimeZone(settings.timezone, now);
  const occurrences = readOccurrences(
    db,
    addDays(addDays(today, -settings.lookbackDays), -pad),
    addDays(addDays(today, settings.lookaheadDays), pad),
  );

  const plan = generatePlan({
    settings,
    rules,
    versions,
    skipPeriods,
    exceptions,
    occurrences,
    now,
  });

  applyPlanToDb(db, plan);

  // A rule that cannot expand stops generating occurrences, which *shrinks* the
  // denominator and therefore silently *improves* the user's adherence. Make it
  // loud, and let the HTTP layer surface it too.
  if (plan.failedRules.length > 0) {
    console.warn(
      `[takalif] ${plan.failedRules.length} rule(s) failed to expand and will not generate occurrences:`,
      plan.failedRules.map((f) => ({ ruleId: f.ruleId, rrule: f.rrule })),
    );
  }

  return plan;
}

function applyPlanToDb(db: DB, plan: GeneratorPlan): void {
  const ts = nowIso();

  const insert = db.prepare(
    `INSERT INTO occurrences
       (id, rule_id, rule_version, scheduled_date, due_time, status, completed_at, note, created_at, updated_at)
     VALUES (@id, @ruleId, @ruleVersion, @scheduledDate, @dueTime, @status, NULL, NULL, @ts, @ts)
     ON CONFLICT (rule_id, scheduled_date) DO NOTHING`,
  );

  // `pending` guard: terminal rows are frozen, so the generator can only ever
  // move a row out of `pending`. COALESCE keeps a user note when the update
  // carries none (a sweep, for instance), matching `applyPlan` semantics.
  const update = db.prepare(
    `UPDATE occurrences
        SET status = @status, note = COALESCE(@note, note), updated_at = @ts
      WHERE id = @id AND status = 'pending'`,
  );

  // Same guard on delete: a row that settled between the plan being computed
  // and this statement must not be removed.
  const remove = db.prepare("DELETE FROM occurrences WHERE id = ? AND status = 'pending'");

  const run = db.transaction(() => {
    for (const o of plan.toInsert) insert.run({ ...o, id: newId(), ts });
    for (const u of [...plan.toUpdate, ...plan.sweep]) {
      update.run({ id: u.id, status: u.status, note: u.note ?? null, ts });
    }
    for (const d of plan.toDelete) remove.run(d.id);
  });

  run();
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface CreateRuleInput {
  title: string;
  description?: string | null;
  rrule: string;
  dtstartDate: string;
  dueTime?: string | null;
  /** The calendar the anchors are interpreted in. */
  calendar: string;
  /** Optional `HH:MM` reminder for that day's occurrence. Null disables. */
  reminderTime?: string | null;
  createdDate: string;
  trackStreak?: boolean;
  category?: string | null;
}

/** Editing a rule opens a new version rather than mutating the old one. */
export function createRule(db: DB, input: CreateRuleInput): Rule {
  const id = newId();
  const ts = nowIso();

  const insert = db.transaction(() => {
    db.prepare(
      `INSERT INTO rules (id, title, description, rrule, dtstart_date, due_time, calendar,
                          reminder_time, created_date, track_streak, category, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      id,
      input.title,
      input.description ?? null,
      input.rrule,
      input.dtstartDate,
      input.dueTime ?? null,
      input.calendar,
      input.reminderTime ?? null,
      input.createdDate,
      input.trackStreak ? 1 : 0,
      input.category ?? null,
      ts,
      ts,
    );
    db.prepare(
      `INSERT INTO rule_versions (id, rule_id, version, rrule, dtstart_date, effective_from, created_at)
       VALUES (?, ?, 1, ?, ?, ?, ?)`,
    ).run(newId(), id, input.rrule, input.dtstartDate, input.createdDate, ts);
  });

  insert();
  return toRule(db.prepare('SELECT * FROM rules WHERE id = ?').get(id) as RuleRow);
}

export interface UpdateRuleInput {
  title?: string;
  description?: string | null;
  rrule?: string;
  dtstartDate?: string;
  dueTime?: string | null;
  calendar?: string;
  /** Reminder time is display/scheduling metadata, not a schedule change. */
  reminderTime?: string | null;
  trackStreak?: boolean;
  category?: string | null;
  /** Local civil date the new schedule takes effect. Defaults to today. */
  effectiveFrom: string;
}

/**
 * Dry run for a schedule change.
 *
 * Reports the three outcomes separately, because conflating them was a bug: the
 * original returned only rows already present in the ledger, so the dates a
 * loosened schedule *adds* could never appear in the preview.
 *
 * - `added`       dates the new schedule introduces, not yet in the ledger
 * - `withdrawn`   existing unlogged occurrences the new schedule drops
 * - `neutralised` existing unlogged occurrences moved to `skipped`
 */
export function previewRuleEdit(
  db: DB,
  ruleId: string,
  input: UpdateRuleInput,
): {
  added: string[];
  withdrawn: Occurrence[];
  neutralised: Occurrence[];
  changed: boolean;
} {
  const empty = { added: [], withdrawn: [], neutralised: [], changed: false };
  const settings = readSettings(db);
  const row = db.prepare('SELECT * FROM rules WHERE id = ?').get(ruleId) as RuleRow | undefined;
  if (!row) return empty;

  const current = toRule(row);
  const nextRrule = input.rrule ?? current.rrule;
  const nextDtstart = input.dtstartDate ?? current.dtstartDate;
  if (nextRrule === current.rrule && nextDtstart === current.dtstartDate) return empty;

  // One clock for the whole probe: reading it twice could straddle midnight and
  // produce a window the plan cannot reconcile against.
  const now = new Date();
  const today = todayInTimeZone(settings.timezone, now);
  const from = addDays(
    addDays(today, -safeWindowDays(settings.lookbackDays, DEFAULT_SETTINGS.lookbackDays)),
    -1,
  );
  const to = addDays(
    addDays(today, safeWindowDays(settings.lookaheadDays, DEFAULT_SETTINGS.lookaheadDays)),
    1,
  );

  const versions = readVersions(db);
  const nextVersion =
    Math.max(0, ...versions.filter((v) => v.ruleId === ruleId).map((v) => v.version)) + 1;

  const existing = readOccurrences(db, from, to);
  const probe = generatePlan({
    settings,
    rules: [{ ...current, rrule: nextRrule, dtstartDate: nextDtstart }],
    versions: [
      ...versions.filter((v) => v.ruleId !== ruleId),
      {
        id: 'preview',
        ruleId,
        version: nextVersion,
        rrule: nextRrule,
        dtstartDate: nextDtstart,
        effectiveFrom: input.effectiveFrom,
        createdAt: now.toISOString(),
      },
    ],
    skipPeriods: readSkipPeriods(db),
    exceptions: readExceptions(db),
    occurrences: existing,
    now,
  });

  const added = probe.toInsert
    .filter((o) => o.ruleId === ruleId)
    .map((o) => o.scheduledDate)
    .sort();

  const byId = new Map(existing.map((o) => [o.id, o]));

  const withdrawn: Occurrence[] = [];
  for (const d of probe.toDelete) {
    const o = byId.get(d.id);
    if (o && o.status === 'pending') withdrawn.push(o);
  }

  const neutralised: Occurrence[] = [];
  for (const u of probe.toUpdate) {
    const o = byId.get(u.id);
    if (o && o.status === 'pending') neutralised.push(o);
  }

  return {
    added,
    withdrawn,
    neutralised,
    changed: added.length > 0 || withdrawn.length > 0 || neutralised.length > 0,
  };
}

export function updateRule(db: DB, ruleId: string, input: UpdateRuleInput): Rule | null {
  const row = db.prepare('SELECT * FROM rules WHERE id = ?').get(ruleId) as RuleRow | undefined;
  if (!row) return null;
  const current = toRule(row);
  const ts = nowIso();

  const nextRrule = input.rrule ?? current.rrule;
  const nextDtstart = input.dtstartDate ?? current.dtstartDate;
  // Changing the calendar reinterprets the anchors, so it is a schedule change.
  const nextCalendar = input.calendar ?? current.calendar;
  const scheduleChanged =
    nextRrule !== current.rrule ||
    nextDtstart !== current.dtstartDate ||
    nextCalendar !== current.calendar;

  const run = db.transaction(() => {
    db.prepare(
      `UPDATE rules SET title = ?, description = ?, rrule = ?, dtstart_date = ?, due_time = ?,
                        calendar = ?, reminder_time = ?, track_streak = ?, category = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.title ?? current.title,
      input.description === undefined ? current.description : input.description,
      nextRrule,
      nextDtstart,
      input.dueTime === undefined ? current.dueTime : input.dueTime,
      nextCalendar,
      input.reminderTime === undefined ? (current.reminderTime ?? null) : input.reminderTime,
      input.trackStreak === undefined ? (current.trackStreak ? 1 : 0) : input.trackStreak ? 1 : 0,
      input.category === undefined ? current.category : input.category,
      ts,
      ruleId,
    );

    if (scheduleChanged) {
      const nextVersion =
        Math.max(
          0,
          ...(db
            .prepare('SELECT version FROM rule_versions WHERE rule_id = ?')
            .all(ruleId) as { version: number }[]).map((r) => r.version),
        ) + 1;
      db.prepare(
        `INSERT INTO rule_versions (id, rule_id, version, rrule, dtstart_date, effective_from, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(newId(), ruleId, nextVersion, nextRrule, nextDtstart, input.effectiveFrom, ts);
    }
  });

  run();
  return toRule(db.prepare('SELECT * FROM rules WHERE id = ?').get(ruleId) as RuleRow);
}

export function setOccurrenceStatus(
  db: DB,
  occurrenceId: string,
  status: Occurrence['status'],
  completedAt: string | null,
): Occurrence | null {
  const ts = nowIso();
  const result = db
    .prepare(
      `UPDATE occurrences SET status = ?, completed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(status, completedAt, ts, occurrenceId);
  if (result.changes === 0) return null;
  return toOccurrence(
    db.prepare('SELECT * FROM occurrences WHERE id = ?').get(occurrenceId) as OccurrenceRow,
  );
}

export function createSkipPeriod(
  db: DB,
  startDate: string,
  endDate: string,
  reason: string | null,
): SkipPeriod {
  const id = newId();
  db.prepare(
    'INSERT INTO skip_periods (id, start_date, end_date, reason, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, startDate, endDate, reason, nowIso());
  return toSkip(db.prepare('SELECT * FROM skip_periods WHERE id = ?').get(id) as SkipRow);
}

export function deleteSkipPeriod(db: DB, id: string): boolean {
  return db.prepare('DELETE FROM skip_periods WHERE id = ?').run(id).changes > 0;
}

/**
 * SQLite has no numeric enforcement unless asked: the schema declares the
 * tables `STRICT` and `CHECK`s the window bounds, and this clamps again so a
 * row written by any other path degrades instead of throwing.
 */
export function sanitiseSettings(current: Settings, patch: Partial<Settings>): Settings {
  const next: Settings = { ...current, ...patch };
  next.lookbackDays = safeWindowDays(next.lookbackDays, DEFAULT_SETTINGS.lookbackDays);
  next.lookaheadDays = safeWindowDays(next.lookaheadDays, DEFAULT_SETTINGS.lookaheadDays);
  return next;
}

export function updateSettings(db: DB, patch: Partial<Settings>): Settings {
  const next = sanitiseSettings(readSettings(db), patch);
  db.prepare(
    'UPDATE settings SET timezone = ?, day_rollover = ?, lookback_days = ?, lookahead_days = ?, default_calendar = ?, email = ?, ntfy_topic = ?, ntfy_server = ? WHERE id = 1',
  ).run(
    next.timezone,
    next.dayRollover,
    next.lookbackDays,
    next.lookaheadDays,
    next.defaultCalendar,
    next.email ?? null,
    next.ntfyTopic ?? null,
    next.ntfyServer ?? null,
  );
  return readSettings(db);
}

export function readOccurrence(db: DB, occurrenceId: string): Occurrence | null {
  const row = db.prepare('SELECT * FROM occurrences WHERE id = ?').get(occurrenceId) as
    | OccurrenceRow
    | undefined;
  return row ? toOccurrence(row) : null;
}

/**
 * Has this occurrence's day already closed?
 *
 * The occurrence for date D stays open until D+1 at the rollover time in the
 * user's own timezone — see the day-boundary ADR.
 */
export function isOccurrenceElapsed(
  occ: Pick<Occurrence, 'scheduledDate'>,
  settings: Settings,
  now: Date = new Date(),
): boolean {
  const closesAt = zonedTimeToUtc(
    addDays(occ.scheduledDate, 1),
    settings.dayRollover,
    settings.timezone,
  );
  return now.getTime() >= closesAt.getTime();
}

/**
 * The only way out of a terminal state, and only while the day is still open.
 *
 * Once the day has closed, leaving the row `pending` is meaningless: the next
 * materialisation sweep would put it straight back to `missed`. Callers must use
 * `excuseOccurrence` for a day that has already passed.
 */
export function resetOccurrence(db: DB, occurrenceId: string): Occurrence | null {
  const result = db
    .prepare(
      "UPDATE occurrences SET status = 'pending', completed_at = NULL, updated_at = ? WHERE id = ?",
    )
    .run(nowIso(), occurrenceId);
  if (result.changes === 0) return null;
  return readOccurrence(db, occurrenceId);
}

/**
 * Excuse an occurrence: `skipped`, so it leaves the adherence denominator,
 * whether or not its day has closed. A deliberate user action, which is why it
 * may write a terminal state.
 */
export function excuseOccurrence(db: DB, occurrenceId: string): Occurrence | null {
  if (!readOccurrence(db, occurrenceId)) return null;
  // A `done` occurrence is a success on record; excusing it would destroy
  // history, so only pending/missed (and idempotently skipped) may move.
  // The route pre-checks for `done` and answers 409; this guard covers races.
  db.prepare(
    "UPDATE occurrences SET status = 'skipped', updated_at = ? WHERE id = ? AND status IN ('pending', 'missed', 'skipped')",
  ).run(nowIso(), occurrenceId);
  return readOccurrence(db, occurrenceId);
}

export interface BulkExcuseResult {
  /** Rows actually moved to `skipped`. */
  excused: number;
}

/**
 * Excuse every unlogged occurrence in a date range, optionally limited to a
 * set of rules. This is what the recovery prompt's "we were away" action
 * calls: after a long absence the sweep has already marked a wall of rows
 * `missed`, and doing that one by one is busywork.
 *
 * `done` rows are never touched — same guard as the single route, enforced in
 * SQL so a concurrent check-off between read and write cannot be undone.
 */
export function bulkExcuseOccurrences(
  db: DB,
  from: string,
  to: string,
  ruleIds?: string[],
): BulkExcuseResult {
  const ts = nowIso();
  if (!ruleIds || ruleIds.length === 0) {
    const result = db
      .prepare(
        `UPDATE occurrences SET status = 'skipped', updated_at = ?
         WHERE scheduled_date BETWEEN ? AND ? AND status IN ('pending', 'missed')`,
      )
      .run(ts, from, to);
    return { excused: Number(result.changes) };
  }
  const placeholders = ruleIds.map(() => '?').join(',');
  const result = db
    .prepare(
      `UPDATE occurrences SET status = 'skipped', updated_at = ?
       WHERE scheduled_date BETWEEN ? AND ? AND status IN ('pending', 'missed')
         AND rule_id IN (${placeholders})`,
    )
    .run(ts, from, to, ...ruleIds);
  return { excused: Number(result.changes) };
}

/**
 * Soft delete. History stays queryable, which is the whole point.
 *
 * An archived rule stops generating, so the generator will never reconcile its
 * rows: future pending occurrences would linger forever and keep appearing in
 * the day view. Withdraw them here, in the same transaction. Past rows are left
 * alone — they are real history and have already settled.
 */
export function archiveRule(db: DB, ruleId: string, today: string): boolean {
  db.transaction(() => {
    db.prepare('UPDATE rules SET active = 0, updated_at = ? WHERE id = ?').run(nowIso(), ruleId);
    db.prepare(
      "DELETE FROM occurrences WHERE rule_id = ? AND status = 'pending' AND scheduled_date > ?",
    ).run(ruleId, today);
  })();
  return true;
}

// ---------------------------------------------------------------------------
// Push subscriptions and reminders
// ---------------------------------------------------------------------------

export interface PushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: string;
}

/** Insert or replace by endpoint: re-subscribing refreshes keys, it never duplicates. */
export function saveSubscription(
  db: DB,
  input: { endpoint: string; p256dh: string; auth: string },
): PushSubscription {
  const ts = nowIso();
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
  ).run(input.endpoint, input.p256dh, input.auth, ts);
  const row = db
    .prepare('SELECT endpoint, p256dh, auth, created_at FROM push_subscriptions WHERE endpoint = ?')
    .get(input.endpoint) as { endpoint: string; p256dh: string; auth: string; created_at: string };
  return { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth, createdAt: row.created_at };
}

export function deleteSubscription(db: DB, endpoint: string): boolean {
  return db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint).changes > 0;
}

export function listSubscriptions(db: DB): PushSubscription[] {
  return (
    db.prepare('SELECT endpoint, p256dh, auth, created_at FROM push_subscriptions').all() as {
      endpoint: string;
      p256dh: string;
      auth: string;
      created_at: string;
    }[]
  ).map((r) => ({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth, createdAt: r.created_at }));
}

export interface DueReminder {
  occurrenceId: string;
  ruleId: string;
  ruleTitle: string;
  scheduledDate: string;
  dueTime: string | null;
  reminderTime: string;
}

/**
 * Occurrences owed a reminder right now: today's rows, still pending, never
 * reminded, belonging to a rule with a reminder time that has passed.
 *
 * Only today's occurrences qualify. Reminding for a missed yesterday would nag
 * about history; reminding for tomorrow would nag too early. The comparison
 * uses the user's timezone, never the server's.
 */
export function findDueReminders(db: DB, now: Date = new Date()): DueReminder[] {
  const settings = readSettings(db);
  const today = todayInTimeZone(settings.timezone, now);
  const rows = db
    .prepare(
      `SELECT o.id AS occurrence_id, o.rule_id, r.title AS rule_title,
              o.scheduled_date, o.due_time, r.reminder_time
       FROM occurrences o
       JOIN rules r ON r.id = o.rule_id
       WHERE o.scheduled_date = ?
         AND o.status = 'pending'
         AND o.reminded_at IS NULL
         AND r.active = 1
         AND r.reminder_time IS NOT NULL`,
    )
    .all(today) as {
    occurrence_id: string;
    rule_id: string;
    rule_title: string;
    scheduled_date: string;
    due_time: string | null;
    reminder_time: string;
  }[];

  return rows
    .filter((r) => {
      try {
        return now.getTime() >= zonedTimeToUtc(today, r.reminder_time, settings.timezone).getTime();
      } catch {
        // A corrupt reminder_time must not break the whole tick.
        return false;
      }
    })
    .map((r) => ({
      occurrenceId: r.occurrence_id,
      ruleId: r.rule_id,
      ruleTitle: r.rule_title,
      scheduledDate: r.scheduled_date,
      dueTime: r.due_time,
      reminderTime: r.reminder_time,
    }));
}

/** Record that an occurrence has been reminded so the next tick skips it. */
export function markReminded(db: DB, occurrenceIds: string[]): void {
  if (occurrenceIds.length === 0) return;
  const placeholders = occurrenceIds.map(() => '?').join(',');
  db.prepare(
    `UPDATE occurrences SET reminded_at = ?, updated_at = ? WHERE id IN (${placeholders})`,
  ).run(nowIso(), nowIso(), ...occurrenceIds);
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export function buildPeriodReport(db: DB, from: string, to: string): PeriodReport {
  const settings = readSettings(db);
  const rules = readRules(db, true);
  const today = todayInTimeZone(settings.timezone, new Date());
  return buildReport({
    settings,
    today,
    from,
    to,
    occurrences: readOccurrences(db, from, to),
    rules: rules.map((r) => ({ id: r.id, title: r.title, trackStreak: r.trackStreak })),
  });
}
