import type { LocalDate } from './dates.js';
import { GREGORIAN, type CalendarKind } from './calendars.js';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface Settings {
  /** IANA zone, e.g. `Europe/Warsaw`. Server-side, never read from the device. */
  timezone: string;
  /** `HH:MM`. A day labelled D stays open until this time on D+1. Default `04:00`. */
  dayRollover: string;
  /** Days before today the generator materialises. */
  lookbackDays: number;
  /** Days after today the generator materialises. */
  lookaheadDays: number;
  /**
   * Default calendar: a display preference and the default for newly created
   * rules. It does not constrain what a rule can be — a rule may use any
   * calendar, and several may be in use simultaneously.
   */
  defaultCalendar: CalendarKind;
  /** Optional destination for fallback email reminders. */
  email?: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  timezone: 'UTC',
  dayRollover: '04:00',
  lookbackDays: 30,
  lookaheadDays: 14,
  defaultCalendar: GREGORIAN,
  email: null,
};

// ---------------------------------------------------------------------------
// Rules (the schedule definition)
// ---------------------------------------------------------------------------

export interface Rule {
  id: string;
  title: string;
  description?: string | null;
  /** RFC 5545 RRULE value, e.g. `FREQ=WEEKLY;BYDAY=TU;INTERVAL=2`. */
  rrule: string;
  /** Local civil date the schedule starts. */
  dtstartDate: LocalDate;
  /** Optional `HH:MM`; when present, lateness becomes derivable. */
  dueTime?: string | null;
  /**
   * The calendar this rule's month and day anchors are interpreted in.
   *
   * A per-rule property, not a global one: a user tracks a tennis session
   * every 15 days on the Gregorian calendar and a fast on 13/14/15 of every
   * Hijri month, side by side. Defaults to the user's preferred calendar.
   */
  calendar: CalendarKind;
  /**
   * Local civil date the user created this rule.
   *
   * Nothing is materialised before this date: you cannot have failed at a
   * commitment you were not yet tracking. Backdating a rule is still possible
   * by moving `dtstartDate`, which is a deliberate act.
   */
  createdDate: LocalDate;
  /** Streaks are opt-in per rule. */
  trackStreak: boolean;
  category?: string | null;
  /** Soft delete. History is always preserved. */
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * An immutable snapshot of a rule's schedule.
 *
 * Editing a rule closes the current version and opens a new one. Every
 * occurrence records the version that produced it, so history is never
 * reinterpreted when a schedule changes.
 */
export interface RuleVersion {
  id: string;
  ruleId: string;
  version: number;
  rrule: string;
  dtstartDate: LocalDate;
  /** Local civil date from which this version is authoritative. */
  effectiveFrom: LocalDate;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Occurrences (the ledger)
// ---------------------------------------------------------------------------

export type OccurrenceStatus = 'pending' | 'done' | 'missed' | 'skipped';

/** `pending` is the only mutable state. The rest are frozen forever. */
export const TERMINAL_STATUSES: readonly OccurrenceStatus[] = ['done', 'missed', 'skipped'];

export function isTerminal(status: OccurrenceStatus): boolean {
  return status !== 'pending';
}

export interface Occurrence {
  id: string;
  ruleId: string;
  /** Which `RuleVersion` generated this row. */
  ruleVersion: number;
  /** Local civil date. Never a UTC instant. */
  scheduledDate: LocalDate;
  dueTime?: string | null;
  status: OccurrenceStatus;
  completedAt?: string | null;
  note?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// Skip periods and exceptions
// ---------------------------------------------------------------------------

/**
 * A holiday, illness, or any other span where misses should not count against
 * adherence. Occurrences inside a span are `skipped`, not `missed`; completing
 * one anyway promotes it to `done` and it counts as a success.
 */
export interface SkipPeriod {
  id: string;
  startDate: LocalDate;
  endDate: LocalDate;
  reason?: string | null;
  createdAt?: string;
}

/** A one-off cancellation, merged with any `EXDATE` inside the RRULE string. */
export interface Exception {
  id?: string;
  ruleId: string;
  date: LocalDate;
}
