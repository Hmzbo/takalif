import { compareDates, eachMonth, isWithin, type LocalDate } from './dates.js';
import { zonedTimeToUtc } from './dates.js';
import type { Occurrence, Settings } from './types.js';

export interface OccurrenceCounts {
  done: number;
  missed: number;
  skipped: number;
  pending: number;
  /** done + missed + skipped. Pending is not elapsed yet, so it is excluded. */
  elapsed: number;
  /** Every row in range, including those still pending. */
  total: number;
}

export function countOccurrences(occurrences: Occurrence[]): OccurrenceCounts {
  const counts: OccurrenceCounts = {
    done: 0,
    missed: 0,
    skipped: 0,
    pending: 0,
    elapsed: 0,
    total: occurrences.length,
  };
  for (const occ of occurrences) {
    if (occ.status === 'pending') {
      counts.pending++;
      continue;
    }
    counts.elapsed++;
    if (occ.status === 'done') counts.done++;
    else if (occ.status === 'missed') counts.missed++;
    else counts.skipped++;
  }
  return counts;
}

export interface AdherenceSummary {
  counts: OccurrenceCounts;
  /**
   * `done / (done + missed)`.
   *
   * Skipped occurrences are excluded from the denominator on purpose: a
   * holiday should not count as failure. `null` when nothing has elapsed yet,
   * which the UI renders as an em dash rather than a misleading 0%.
   */
  adherence: number | null;
  /** Fraction of elapsed occurrences that were skipped, for display context. */
  skipRate: number | null;
  /** Completed after `dueTime`, only for occurrences that carry one. */
  late: number;
  lateRate: number | null;
  /** Misses in the trailing 7 / 30 days — "you are 3 days behind". */
  behind: { last7: number; last30: number };
}

const DAY_MS = 86_400_000;

export function summarise(
  occurrences: Occurrence[],
  options: { today: LocalDate; settings: Settings; now?: Date },
): AdherenceSummary {
  const { today, settings, now = new Date() } = options;
  const counts = countOccurrences(occurrences);
  const denominator = counts.done + counts.missed;

  // Lateness is derived from `completed_at` versus the occurrence's own due
  // time, so it never needs to be stored as a separate state.
  let late = 0;
  for (const occ of occurrences) {
    if (occ.status !== 'done' || !occ.dueTime || !occ.completedAt) continue;
    const due = zonedTimeToUtc(occ.scheduledDate, occ.dueTime, settings.timezone);
    if (new Date(occ.completedAt).getTime() > due.getTime()) late++;
  }

  const cutoff7 = shift(today, -7);
  const cutoff30 = shift(today, -30);
  const behind = {
    last7: occurrences.filter(
      (o) => o.status === 'missed' && isWithin(o.scheduledDate, cutoff7, today),
    ).length,
    last30: occurrences.filter(
      (o) => o.status === 'missed' && isWithin(o.scheduledDate, cutoff30, today),
    ).length,
  };

  void now;

  return {
    counts,
    adherence: denominator === 0 ? null : counts.done / denominator,
    skipRate: counts.elapsed === 0 ? null : counts.skipped / counts.elapsed,
    late,
    lateRate: counts.done === 0 ? null : late / counts.done,
    behind,
  };
}

export interface Streak {
  current: number;
  best: number;
  longestRunStart: LocalDate | null;
}

/**
 * Walk elapsed occurrences newest-first.
 *
 * `done` extends the run, `missed` breaks it, and `skipped` is neutral: a
 * holiday neither extends a streak nor destroys one. `pending` is not a
 * terminal state, so it is skipped rather than treated as a break.
 */
export function computeStreak(
  occurrences: Occurrence[],
  options: { today: LocalDate },
): Streak {
  const elapsed = occurrences
    .filter((o) => o.status !== 'pending')
    .sort((a, b) => compareDates(b.scheduledDate, a.scheduledDate));

  // Walking newest-first, a run is only complete once a miss or the end of the
  // list is reached. `start` therefore holds the chronologically oldest date
  // of that run, because the last write within a run is its earliest date.
  let run = 0;
  let start: LocalDate | null = null;
  const runs: { length: number; start: LocalDate | null }[] = [];

  for (const occ of elapsed) {
    if (occ.status === 'missed') {
      runs.push({ length: run, start });
      run = 0;
      start = null;
      continue;
    }
    // `skipped` is neutral: it neither extends a streak nor destroys one.
    if (occ.status !== 'done') continue;
    start = occ.scheduledDate;
    run++;
  }
  runs.push({ length: run, start });

  // The newest run is the first one completed.
  const current = runs[0]?.length ?? 0;
  const bestRun = runs.reduce((a, b) => (b.length > a.length ? b : a));

  return {
    current,
    best: bestRun.length,
    longestRunStart: bestRun.length > 0 ? bestRun.start : null,
  };
}

export interface TrendPoint {
  bucket: LocalDate;
  adherence: number | null;
  counts: OccurrenceCounts;
}

/** Adherence bucketed by month, for a sparkline across months. */
export function monthlyTrend(
  occurrences: Occurrence[],
  range: { from: LocalDate; to: LocalDate },
): TrendPoint[] {
  return eachMonth(range.from, range.to).map((bucket) => {
    const slice = occurrences.filter((o) => o.scheduledDate.startsWith(bucket.slice(0, 7)));
    const counts = countOccurrences(slice);
    const denominator = counts.done + counts.missed;
    return { bucket, adherence: denominator === 0 ? null : counts.done / denominator, counts };
  });
}

export interface RuleBreakdown {
  ruleId: string;
  title: string;
  summary: AdherenceSummary;
  streak: Streak | null;
}

export interface PeriodReport {
  from: LocalDate;
  to: LocalDate;
  overall: AdherenceSummary;
  trend: TrendPoint[];
  perRule: RuleBreakdown[];
}

export interface BuildReportInput {
  settings: Settings;
  today: LocalDate;
  from: LocalDate;
  to: LocalDate;
  occurrences: Occurrence[];
  /** id -> title, and whether streaks are tracked for that rule. */
  rules: { id: string; title: string; trackStreak: boolean }[];
}

/**
 * The primary view: overall adherence for a period, its trend, and a per-rule
 * breakdown. Failures are present in every figure but never the headline.
 */
export function buildReport(input: BuildReportInput): PeriodReport {
  const { settings, today, from, to, occurrences, rules } = input;
  const inRange = occurrences.filter((o) => isWithin(o.scheduledDate, from, to));
  const ruleMap = new Map(rules.map((r) => [r.id, r]));

  return {
    from,
    to,
    overall: summarise(inRange, { today, settings }),
    trend: monthlyTrend(inRange, { from, to }),
    perRule: rules
      .map((rule) => {
        const slice = inRange.filter((o) => o.ruleId === rule.id);
        if (slice.length === 0) return null;
        return {
          ruleId: rule.id,
          title: rule.title,
          summary: summarise(slice, { today, settings }),
          streak: rule.trackStreak ? computeStreak(slice, { today }) : null,
        } satisfies RuleBreakdown;
      })
      .filter((r): r is RuleBreakdown => r !== null),
  };
}

function shift(date: LocalDate, days: number): LocalDate {
  return new Date(
    Date.UTC(
      Number(date.slice(0, 4)),
      Number(date.slice(5, 7)) - 1,
      Number(date.slice(8, 10)) + days,
    ),
  )
    .toISOString()
    .slice(0, 10);
}
