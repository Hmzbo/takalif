/**
 * Calendar-date utilities.
 *
 * CORE INVARIANT: a "local civil date" is a `YYYY-MM-DD` string and nothing else.
 * It has no time and no offset. All calendar arithmetic is performed on
 * UTC-midnight `Date` objects purely as a convenient integer carrier, so that
 * daylight-saving transitions can never alter a date bucket. A 23-hour day and
 * a 25-hour day are indistinguishable here, which is exactly what we want.
 *
 * The only place real wall-clock time enters is when we need to answer
 * "is it still today?" and "has this day's bucket closed yet?", and those
 * always go through the user's configured IANA timezone.
 */

/** A calendar date with no time or offset, e.g. `2026-09-30`. */
export type LocalDate = string;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse `YYYY-MM-DD` into a UTC-midnight Date used for arithmetic. */
export function parseDate(date: LocalDate): Date {
  const m = ISO_DATE.exec(date);
  if (!m) throw new RangeError(`Invalid LocalDate: ${JSON.stringify(date)}`);
  const [, y, mo, d] = m;
  const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  // Reject impossible dates such as 2026-02-31, which Date.UTC would roll over.
  if (formatDate(dt) !== date) {
    throw new RangeError(`Invalid calendar date: ${date}`);
  }
  return dt;
}

/** Format a UTC-midnight Date back into a `YYYY-MM-DD` string. */
export function formatDate(dt: Date): LocalDate {
  return dt.toISOString().slice(0, 10);
}

export function isValidDate(date: unknown): date is LocalDate {
  if (typeof date !== 'string' || !ISO_DATE.test(date)) return false;
  try {
    parseDate(date);
    return true;
  } catch {
    return false;
  }
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return formatDate(new Date(parseDate(date).getTime() + days * 86_400_000));
}

export function addMonths(date: LocalDate, months: number): LocalDate {
  const d = parseDate(date);
  const targetMonth = d.getUTCMonth() + months;
  const result = new Date(Date.UTC(d.getUTCFullYear(), targetMonth, 1));
  // Clamp to the last valid day of the target month (Jan 31 + 1mo -> Feb 28/29).
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return formatDate(result);
}

/** Whole days from `a` to `b`; negative when `b` precedes `a`. */
export function daysBetween(a: LocalDate, b: LocalDate): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 86_400_000);
}

/** -1 | 0 | 1, string-comparison is safe because the format sorts lexicographically. */
export function compareDates(a: LocalDate, b: LocalDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isWithin(date: LocalDate, from: LocalDate, to: LocalDate): boolean {
  return date >= from && date <= to;
}

export function minDate(a: LocalDate, b: LocalDate): LocalDate {
  return a <= b ? a : b;
}

export function maxDate(a: LocalDate, b: LocalDate): LocalDate {
  return a >= b ? a : b;
}

/** Inclusive list of dates from `from` to `to`. */
export function eachDate(from: LocalDate, to: LocalDate): LocalDate[] {
  const out: LocalDate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function eachMonth(from: LocalDate, to: LocalDate): LocalDate[] {
  const out: LocalDate[] = [];
  let cursor = `${from.slice(0, 7)}-01`;
  while (cursor <= to) {
    out.push(cursor);
    cursor = addMonths(cursor, 1);
  }
  return out;
}

export function startOfMonth(date: LocalDate): LocalDate {
  return `${date.slice(0, 7)}-01`;
}

export function endOfMonth(date: LocalDate): LocalDate {
  return formatDate(new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)));
}

// ---------------------------------------------------------------------------
// Timezone-aware helpers. These are the only functions that consult a clock.
// ---------------------------------------------------------------------------

/**
 * Cache `Intl.DateTimeFormat` per timezone.
 *
 * Constructing one costs tens of microseconds, and `timeZoneOffsetMs` is called
 * per occurrence in the lateness calculation, so an uncached formatter turned a
 * statistics query into a formatter-construction benchmark.
 */
const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

function offsetFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = offsetFormatters.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  offsetFormatters.set(timeZone, created);
  return created;
}

/** Offset of `tz` from UTC, in ms, at the given instant. */
function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = offsetFormatter(timeZone).formatToParts(instant);

  const field: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== 'literal') field[p.type] = Number(p.value);
  }
  const asIfUTC = Date.UTC(
    field.year!,
    field.month! - 1,
    field.day!,
    field.hour! % 24,
    field.minute!,
    field.second!,
  );
  return asIfUTC - instant.getTime();
}

/** The calendar date currently showing in `timeZone`. */
export function todayInTimeZone(timeZone: string, now: Date = new Date()): LocalDate {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Convert a wall-clock time expressed in `timeZone` to a UTC instant.
 * Resolves DST boundaries by iterating the offset to a fixed point.
 */
export function zonedTimeToUtc(
  date: LocalDate,
  time: string,
  timeZone: string,
): Date {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = parseTime(time);
  const wallClock = Date.UTC(y, mo - 1, d, hh, mm);

  let offset = timeZoneOffsetMs(new Date(wallClock), timeZone);
  let instant = wallClock - offset;
  const refined = timeZoneOffsetMs(new Date(instant), timeZone);
  if (refined !== offset) {
    offset = refined;
    instant = wallClock - offset;
  }
  return new Date(instant);
}

/** `HH:MM` -> `[hours, minutes]`, with validation. */
export function parseTime(time: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m) throw new RangeError(`Invalid time: ${JSON.stringify(time)}`);
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) throw new RangeError(`Invalid time: ${time}`);
  return [hh, mm];
}

export function isValidTime(time: unknown): time is string {
  if (typeof time !== 'string') return false;
  try {
    parseTime(time);
    return true;
  } catch {
    return false;
  }
}

/** Local midnight of `date` in `timeZone`, as a UTC instant. */
export function startOfDayInstant(date: LocalDate, timeZone: string): Date {
  return zonedTimeToUtc(date, '00:00', timeZone);
}
