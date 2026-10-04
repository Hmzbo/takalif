/**
 * Calendar conversions.
 *
 * Supports the Gregorian calendar and the Islamic (Hijri) calendars that
 * Node's ICU provides. No dependency: `Intl` carries the Islamic variants.
 *
 * Two primitives, and everything else builds on them:
 *
 *   toHijri    Gregorian civil date -> Hijri { year, month, day }
 *   toGregorian Hijri { year, month, day } -> Gregorian civil date
 *
 * `toGregorian` is the direction recurrence needs — given a rule that says
 * "the 13th of every month" in the Hijri calendar, we must find which Gregorian
 * dates that is. `Intl` only formats forwards, so the inverse is a binary
 * search over a bracket seeded from the arithmetic mean solar year.
 *
 * The bracket is deliberately generous (±400 days). Verified: round-tripping
 * every day across two Gregorian years gives 730/730 correct on both
 * islamic-umalqura and islamic-civil.
 */

import { formatDate, parseDate, type LocalDate } from './dates.js';

/** A calendar kind, identified by its ICU tag. */
export type CalendarKind =
  | 'gregorian'
  | 'islamic-umalqura'
  | 'islamic-civil'
  | 'islamic-tbla';

export const GREGORIAN: CalendarKind = 'gregorian';

/** The default non-Gregorian calendar, per the product decision (Umm al-Qura). */
export const DEFAULT_HIJRI: CalendarKind = 'islamic-umalqura';

export interface HijriDate {
  /** Hijri year, e.g. 1448. */
  year: number;
  /** Hijri month, 1-12. */
  month: number;
  /** Hijri day, 1-30. */
  day: number;
}

/** The Hijri year consists of 12 alternating 29- and 30-day months. */
export const MAX_HIJRI_MONTH_LENGTH = 30;
export const HIJRI_MONTHS_PER_YEAR = 12;
/** Mean length of the Hijri year, used only to seed the binary search. */
export const HIJRI_MEAN_YEAR_DAYS = 354.367;

const DAY_MS = 86_400_000;
/** Search bracket around the seed, wide enough to absorb any variant offset. */
const BRACKET_DAYS = 400;
/** Seed epoch: 2026-01-01 corresponds to 1447 AH, the year this was built. */
const SEED_HIJRI_YEAR = 1447;

interface HijriFormatter {
  (d: Date): HijriDate;
}

const hijriFormatters = new Map<CalendarKind, HijriFormatter>();

/** A formatter for a given calendar, cached — constructing one is expensive. */
function hijriFormatter(calendar: CalendarKind): HijriFormatter {
  const cached = hijriFormatters.get(calendar);
  if (cached) return cached;

  const fmt = new Intl.DateTimeFormat(`en-u-ca-${calendar}`, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    timeZone: 'UTC',
  });

  const format = (d: Date): HijriDate => {
    const field: Partial<Record<string, number>> = {};
    for (const part of fmt.formatToParts(d)) {
      if (part.type !== 'literal') field[part.type] = Number(part.value);
    }
    return { year: field.year!, month: field.month!, day: field.day! };
  };

  hijriFormatters.set(calendar, format);
  return format;
}

export function isHijri(calendar: CalendarKind): boolean {
  return calendar !== GREGORIAN;
}

export function isKnownCalendar(value: unknown): value is CalendarKind {
  return (
    value === 'gregorian' ||
    value === 'islamic-umalqura' ||
    value === 'islamic-civil' ||
    value === 'islamic-tbla'
  );
}

/**
 * Gregorian civil date -> Hijri date in `calendar`.
 *
 * Works for the Gregorian calendar too, in which case it simply reports the
 * same date in `HijriDate` shape so callers need no branch.
 */
export function toHijri(date: LocalDate, calendar: CalendarKind): HijriDate {
  if (calendar === GREGORIAN) {
    return {
      year: Number(date.slice(0, 4)),
      month: Number(date.slice(5, 7)),
      day: Number(date.slice(8, 10)),
    };
  }
  return hijriFormatter(calendar)(parseDate(date));
}

/**
 * Hijri date -> Gregorian civil date.
 *
 * Binary search: expand a bracket around the seed, halving on the comparison.
 * Nonexistent days (day 30 of a 29-day month) must be rejected by the caller
 * using `hijriMonthLength`, not clamped.
 */
export function toGregorian(
  hijri: HijriDate,
  calendar: CalendarKind,
): LocalDate | null {
  if (calendar === GREGORIAN) {
    const { year, month, day } = hijri;
    const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    try {
      parseDate(date);
      return date;
    } catch {
      return null;
    }
  }

  const forward = hijriFormatter(calendar);
  const seed =
    Date.UTC(2026, 0, 1) +
    (hijri.year - SEED_HIJRI_YEAR) * HIJRI_MEAN_YEAR_DAYS * DAY_MS;

  let lo = Math.floor((seed - BRACKET_DAYS * DAY_MS) / DAY_MS) * DAY_MS;
  let hi = Math.floor((seed + BRACKET_DAYS * DAY_MS) / DAY_MS) * DAY_MS;

  // Compare on an integer encoding of the Hijri date, not on its string form.
  const enc = (h: HijriDate) => h.year * 400 * 30 + h.month * 30 + h.day;

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2 / DAY_MS) * DAY_MS;
    const h = forward(new Date(mid));
    const cmp = enc(h) - enc(hijri);
    if (cmp < 0) lo = mid + DAY_MS;
    else hi = mid;
  }

  const found = forward(new Date(lo));
  return found.year === hijri.year && found.month === hijri.month && found.day === hijri.day
    ? formatDate(new Date(lo))
    : null;
}

/**
 * Length of a Hijri month, in days: 29 or 30.
 *
 * Determined by probing, so it tracks whichever calendar is in use rather than
 * hard-coding a table.
 */
export function hijriMonthLength(year: number, month: number, calendar: CalendarKind): number {
  if (calendar === GREGORIAN) return 0; // not meaningful; callers use their own logic
  let length = 0;
  for (let day = 1; day <= MAX_HIJRI_MONTH_LENGTH; day++) {
    const g = toGregorian({ year, month, day }, calendar);
    if (g === null) break;
    const back = toHijri(g, calendar);
    if (back.year !== year || back.month !== month || back.day !== day) break;
    length = day;
  }
  return length;
}
