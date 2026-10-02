import { randomUUID } from 'node:crypto';
import {
  addDays,
  buildReport,
  DEFAULT_SETTINGS,
  generatePlan,
  todayInTimeZone,
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
  email: string | null;
}

interface RuleRow {
  id: string;
  title: string;
  description: string | null;
  rrule: string;
  dtstart_date: string;
  due_time: string | null;
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
  email: r.email,
});

const toRule = (r: RuleRow): Rule => ({
  id: r.id,
  title: r.title,
  description: r.description,
  rrule: r.rrule,
  dtstartDate: r.dtstart_date,
  dueTime: r.due_time,
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

  const update = db.prepare(
    'UPDATE occurrences SET status = @status, note = @note, updated_at = @ts WHERE id = @id AND status = \'pending\'',
  );

  const remove = db.prepare('DELETE FROM occurrences WHERE id = ?');

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
      `INSERT INTO rules (id, title, description, rrule, dtstart_date, due_time, created_date,
                          track_streak, category, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      id,
      input.title,
      input.description ?? null,
      input.rrule,
      input.dtstartDate,
      input.dueTime ?? null,
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
  trackStreak?: boolean;
  category?: string | null;
  /** Local civil date the new schedule takes effect. Defaults to today. */
  effectiveFrom: string;
}

/**
 * Returns the set of occurrences that the edit invalidated, so the caller can
 * present them before anything is rewritten.
 */
export function previewRuleEdit(
  db: DB,
  ruleId: string,
  input: UpdateRuleInput,
): { invalidated: Occurrence[] } {
  const settings = readSettings(db);
  const rule = db.prepare('SELECT * FROM rules WHERE id = ?').get(ruleId) as RuleRow | undefined;
  if (!rule) return { invalidated: [] };

  const current = toRule(rule);
  const nextRrule = input.rrule ?? current.rrule;
  const nextDtstart = input.dtstartDate ?? current.dtstartDate;

  if (nextRrule === current.rrule && nextDtstart === current.dtstartDate) {
    return { invalidated: [] };
  }

  const versions = readVersions(db);
  const probe = generatePlan({
    settings,
    rules: [{ ...current, rrule: nextRrule, dtstartDate: nextDtstart }],
    versions: [
      ...versions.filter((v) => v.ruleId !== ruleId),
      {
        id: 'preview',
        ruleId,
        version: Math.max(0, ...versions.filter((v) => v.ruleId === ruleId).map((v) => v.version)) + 1,
        rrule: nextRrule,
        dtstartDate: nextDtstart,
        effectiveFrom: input.effectiveFrom,
        createdAt: nowIso(),
      },
    ],
    skipPeriods: readSkipPeriods(db),
    exceptions: readExceptions(db),
    occurrences: readOccurrences(
      db,
      addDays(addDays(todayInTimeZone(settings.timezone, new Date()), -settings.lookbackDays), -1),
      addDays(addDays(todayInTimeZone(settings.timezone, new Date()), settings.lookaheadDays), 1),
    ),
    now: new Date(),
  });

  const touched = new Set([
    ...probe.toInsert.map((o) => `${o.ruleId}|${o.scheduledDate}`),
    ...probe.toUpdate.map((u) => u.id),
    ...probe.toDelete.map((d) => d.id),
  ]);

  const invalidated = readOccurrences(
    db,
    addDays(addDays(todayInTimeZone(settings.timezone, new Date()), -settings.lookbackDays), -1),
    addDays(addDays(todayInTimeZone(settings.timezone, new Date()), settings.lookaheadDays), 1),
  ).filter((o) => o.ruleId === ruleId && o.status === 'pending' && touched.has(o.id));

  return { invalidated };
}

export function updateRule(db: DB, ruleId: string, input: UpdateRuleInput): Rule | null {
  const row = db.prepare('SELECT * FROM rules WHERE id = ?').get(ruleId) as RuleRow | undefined;
  if (!row) return null;
  const current = toRule(row);
  const ts = nowIso();

  const nextRrule = input.rrule ?? current.rrule;
  const nextDtstart = input.dtstartDate ?? current.dtstartDate;
  const scheduleChanged = nextRrule !== current.rrule || nextDtstart !== current.dtstartDate;

  const run = db.transaction(() => {
    db.prepare(
      `UPDATE rules SET title = ?, description = ?, rrule = ?, dtstart_date = ?, due_time = ?,
                        track_streak = ?, category = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.title ?? current.title,
      input.description === undefined ? current.description : input.description,
      nextRrule,
      nextDtstart,
      input.dueTime === undefined ? current.dueTime : input.dueTime,
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

/** Soft delete. History stays queryable, which is the whole point. */
export function archiveRule(db: DB, ruleId: string): boolean {
  return db
    .prepare('UPDATE rules SET active = 0, updated_at = ? WHERE id = ?')
    .run(nowIso(), ruleId).changes > 0;
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

export function updateSettings(db: DB, patch: Partial<Settings>): Settings {
  const current = readSettings(db);
  const next: Settings = { ...current, ...patch };
  db.prepare(
    'UPDATE settings SET timezone = ?, day_rollover = ?, lookback_days = ?, lookahead_days = ?, email = ? WHERE id = 1',
  ).run(
    next.timezone,
    next.dayRollover,
    next.lookbackDays,
    next.lookaheadDays,
    next.email ?? null,
  );
  return readSettings(db);
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
