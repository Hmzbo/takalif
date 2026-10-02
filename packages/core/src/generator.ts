import {
  addDays,
  compareDates,
  daysBetween,
  formatDate,
  isWithin,
  maxDate,
  minDate,
  parseDate,
  todayInTimeZone,
  zonedTimeToUtc,
  type LocalDate,
} from './dates.js';
import { expandRRule, InvalidRRuleError } from './rrule.js';
import {
  isTerminal,
  type Exception,
  type Occurrence,
  type OccurrenceStatus,
  type Rule,
  type RuleVersion,
  type Settings,
  type SkipPeriod,
} from './types.js';

export interface PlannedOccurrence {
  ruleId: string;
  ruleVersion: number;
  scheduledDate: LocalDate;
  dueTime: string | null;
  status: OccurrenceStatus;
}

export interface OccurrenceUpdate {
  id: string;
  status: OccurrenceStatus;
  note?: string | null;
}

/** A pending occurrence whose day has closed and which is being marked missed. */
export interface SweepUpdate extends OccurrenceUpdate {
  ruleId: string;
  scheduledDate: LocalDate;
}

export interface OccurrenceDelete {
  id: string;
  ruleId: string;
  scheduledDate: LocalDate;
}

/**
 * Offered when a long absence would otherwise be recorded as a wall of
 * failures. Without this, the first holiday a user takes permanently poisons
 * their statistics and they lose trust in the numbers.
 */
export interface RecoveryPrompt {
  from: LocalDate;
  to: LocalDate;
  count: number;
  ruleIds: string[];
}

export interface GeneratorPlan {
  today: LocalDate;
  window: { from: LocalDate; to: LocalDate };
  toInsert: PlannedOccurrence[];
  toUpdate: OccurrenceUpdate[];
  toDelete: OccurrenceDelete[];
  sweep: SweepUpdate[];
  /** Rows materialised straight into `missed` because their day had already closed. */
  recovered: { ruleId: string; scheduledDate: LocalDate }[];
  recoveryPrompt: RecoveryPrompt | null;
  /** Rules whose RRULE could not be expanded. They must not break the ledger. */
  failedRules: { ruleId: string; rrule: string; error: string }[];
}

export interface GeneratorInput {
  settings: Settings;
  rules: Rule[];
  versions: RuleVersion[];
  skipPeriods: SkipPeriod[];
  exceptions: Exception[];
  /** Occurrences already persisted, scoped by the caller to a superset of the window. */
  occurrences: Occurrence[];
  /** Injectable clock. Defaults to wall-clock now. */
  now?: Date;
  /** Sweeps larger than this surface a recovery prompt instead of silently failing. */
  recoveryThreshold?: number;
}

export const DEFAULT_RECOVERY_THRESHOLD = 14;

const RULE_CHANGED_NOTE = 'schedule changed';

/**
 * Pure planner. Reads state, returns a plan, touches nothing.
 *
 * The caller applies `toInsert` / `toUpdate` / `toDelete` / `sweep` in one
 * transaction, then invalidates whatever it cached.
 *
 * Invariants this function guarantees:
 *  - idempotent: two runs over unchanged input produce no work
 *  - terminal occurrences (`done` / `missed` / `skipped`) are never modified
 *  - output does not depend on the host machine's timezone
 */
export function generatePlan(input: GeneratorInput): GeneratorPlan {
  const { settings, now = new Date(), recoveryThreshold = DEFAULT_RECOVERY_THRESHOLD } = input;

  const today = todayInTimeZone(settings.timezone, now);
  const window = {
    from: addDays(today, -Math.max(0, settings.lookbackDays)),
    to: addDays(today, Math.max(0, settings.lookaheadDays)),
  };

  const plan: GeneratorPlan = {
    today,
    window,
    toInsert: [],
    toUpdate: [],
    toDelete: [],
    sweep: [],
    recovered: [],
    recoveryPrompt: null,
    failedRules: [],
  };

  const versionsByRule = groupBy(input.versions, (v) => v.ruleId);
  const existingByRule = groupBy(input.occurrences, (o) => o.ruleId);
  const exceptionDates = new Set(input.exceptions.map((e) => `${e.ruleId}|${e.date}`));
  const exdates = extractExDates(input.rules);

  for (const rule of input.rules) {
    if (!rule.active) continue;

    const versions = (versionsByRule.get(rule.id) ?? []).slice().sort(compareVersions);
    if (versions.length === 0) continue;

    // ---- Resolve the expected occurrence set over the window ----------------
    const expected = new Map<LocalDate, { version: number; dueTime: string | null }>();

    for (let i = 0; i < versions.length; i++) {
      const version = versions[i]!;
      const next = versions[i + 1];

      // Clip this version to the span it actually governs.
      const lo = maxDate(window.from, version.effectiveFrom);
      const hi = minDate(
        window.to,
        next ? addDays(next.effectiveFrom, -1) : window.to,
      );
      if (lo > hi) continue;

      let dates: LocalDate[];
      try {
        dates = expandRRule({
          rrule: version.rrule,
          dtstart: version.dtstartDate,
          from: lo,
          to: hi,
        });
      } catch (error) {
        if (error instanceof InvalidRRuleError) {
          plan.failedRules.push({ ruleId: rule.id, rrule: version.rrule, error: error.message });
          continue;
        }
        throw error;
      }

      for (const date of dates) {
        // You cannot have failed at a commitment you were not yet tracking.
        if (date < rule.createdDate) continue;
        // A one bad rule must never take down the whole ledger.
        if (exceptionDates.has(`${rule.id}|${date}`)) continue;
        if (exdates.has(`${rule.id}|${date}`)) continue;
        expected.set(date, { version: version.version, dueTime: rule.dueTime ?? null });
      }
    }

    // ---- Reconcile what is already stored ----------------------------------
    const existing = existingByRule.get(rule.id) ?? [];
    const byDate = new Map<LocalDate, Occurrence>();
    for (const occ of existing) byDate.set(occ.scheduledDate, occ);

    // Track the post-plan status so later steps respect earlier transitions.
    const projected = new Map<LocalDate, OccurrenceStatus>();
    for (const occ of existing) projected.set(occ.scheduledDate, occ.status);

    const ruleChanges: OccurrenceUpdate[] = [];

    // A day's bucket closes at D+1 at the rollover time, in the user's own
    // timezone. Closing it at local midnight would mark every task done after
    // dinner as failed, so this threshold is deliberately later than midnight.
    const dayClosed = (date: LocalDate): boolean =>
      now.getTime() >=
      zonedTimeToUtc(addDays(date, 1), settings.dayRollover, settings.timezone).getTime();

    /**
     * Status for a row being materialised right now. A past date that is not
     * already covered by a skip period is born `missed` rather than `pending`,
     * so widening the lookback window never leaves a backlog of stale rows.
     */
    const initialStatus = (date: LocalDate): OccurrenceStatus => {
      if (skipStatusFor(date, input.skipPeriods) === 'skipped') return 'skipped';
      if (dayClosed(date)) return 'missed';
      return 'pending';
    };

    for (const [date, meta] of expected) {
      if (byDate.has(date)) continue;
      const status = initialStatus(date);
      plan.toInsert.push({
        ruleId: rule.id,
        ruleVersion: meta.version,
        scheduledDate: date,
        dueTime: meta.dueTime,
        status,
      });
      if (status === 'missed') {
        plan.recovered.push({ ruleId: rule.id, scheduledDate: date });
      }
    }

    for (const occ of existing) {
      // Only rows we are allowed to move, and only inside the window.
      if (isTerminal(occ.status)) continue;
      if (!isWithin(occ.scheduledDate, window.from, window.to)) continue;

      if (!expected.has(occ.scheduledDate)) {
        // No longer part of the schedule. Drop a future row; neutralise a past one.
        if (compareDates(occ.scheduledDate, today) > 0) {
          plan.toDelete.push({ id: occ.id, ruleId: rule.id, scheduledDate: occ.scheduledDate });
          projected.delete(occ.scheduledDate);
        } else {
          ruleChanges.push({ id: occ.id, status: 'skipped', note: RULE_CHANGED_NOTE });
          projected.set(occ.scheduledDate, 'skipped');
        }
        continue;
      }

      // Still expected, but a newly created skip period may now cover it.
      if (skipStatusFor(occ.scheduledDate, input.skipPeriods) === 'skipped') {
        ruleChanges.push({ id: occ.id, status: 'skipped' });
        projected.set(occ.scheduledDate, 'skipped');
      }
    }

    plan.toUpdate.push(...ruleChanges);

    // ---- Sweep elapsed-but-untouched occurrences into `missed` -------------
    for (const occ of existing) {
      if (projected.get(occ.scheduledDate) !== 'pending') continue;
      if (!isWithin(occ.scheduledDate, window.from, window.to)) continue;

      if (dayClosed(occ.scheduledDate)) {
        plan.sweep.push({
          id: occ.id,
          ruleId: rule.id,
          scheduledDate: occ.scheduledDate,
          status: 'missed',
        });
        projected.set(occ.scheduledDate, 'missed');
      }
    }
  }

  plan.recoveryPrompt = buildRecoveryPrompt(plan, recoveryThreshold);
  return plan;
}

/**
 * When a long absence would be recorded as a wall of failures, offer the user
 * a way out instead of silently poisoning their history.
 *
 * Counts both freshly materialised misses and swept pending rows, because
 * widening the lookback window produces the same situation.
 */
function buildRecoveryPrompt(plan: GeneratorPlan, threshold: number): RecoveryPrompt | null {
  const entries: { ruleId: string; date: LocalDate }[] = [
    ...plan.sweep.map((s) => ({ ruleId: s.ruleId, date: s.scheduledDate })),
    ...plan.recovered.map((r) => ({ ruleId: r.ruleId, date: r.scheduledDate })),
  ];
  if (entries.length < threshold) return null;

  let from: LocalDate | null = null;
  let to: LocalDate | null = null;
  const ruleIds = new Set<string>();

  for (const e of entries) {
    if (from === null || compareDates(e.date, from) < 0) from = e.date;
    if (to === null || compareDates(e.date, to) > 0) to = e.date;
    ruleIds.add(e.ruleId);
  }

  if (from === null || to === null) return null;
  return { from, to, count: entries.length, ruleIds: [...ruleIds] };
}

function skipStatusFor(date: LocalDate, periods: SkipPeriod[]): OccurrenceStatus {
  return periods.some((p) => isWithin(date, p.startDate, p.endDate)) ? 'skipped' : 'pending';
}

/** Pull `EXDATE` entries out of an RRULE string so we can merge them with the exceptions table. */
function extractExDates(rules: Rule[]): Set<string> {
  const out = new Set<string>();
  for (const rule of rules) {
    const match = /EXDATE[^:\n]*:(.+)/i.exec(rule.rrule);
    if (!match?.[1]) continue;
    for (const raw of match[1].split(',')) {
      const compact = raw.replace(/[^0-9]/g, '');
      if (compact.length !== 8) continue;
      const date = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
      out.add(`${rule.id}|${date}`);
    }
  }
  return out;
}

function compareVersions(a: RuleVersion, b: RuleVersion): number {
  const byDate = compareDates(a.effectiveFrom, b.effectiveFrom);
  return byDate !== 0 ? byDate : a.version - b.version;
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = map.get(k);
    if (bucket) bucket.push(item);
    else map.set(k, [item]);
  }
  return map;
}

export { formatDate, parseDate, daysBetween };
