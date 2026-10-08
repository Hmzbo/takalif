import { shiftDate } from './format';

/**
 * Pure date-grid math for the Calendar tab.
 *
 * Display-only arithmetic on UTC-midnight carriers, the same technique as
 * `shiftDate`: a 23-hour day and a 25-hour day are indistinguishable, so DST
 * can never shift a cell. Weeks start Monday (ISO); the grid is data only and
 * flips with `dir="rtl"` like everything else.
 */

/** Monday of the week containing `date` (`YYYY-MM-DD` in, same out). */
export function weekStart(date: string): string {
  const dt = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) throw new RangeError(`Invalid date: ${date}`);
  const back = (dt.getUTCDay() + 6) % 7; // days since Monday
  return shiftDate(date, -back);
}

/** Seven consecutive dates starting at a Monday. */
export function weekDays(monday: string): string[] {
  return Array.from({ length: 7 }, (_, i) => shiftDate(monday, i));
}

/** First civil date of the month containing `date`. */
export function monthFirst(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** Shift a date by whole calendar months, clamping to the target month length. */
export function shiftMonth(date: string, delta: number): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  if (
    !Number.isInteger(y) ||
    !Number.isInteger(m) ||
    m < 1 ||
    m > 12 ||
    !Number.isInteger(d) ||
    d < 1 ||
    d > 31
  ) {
    throw new RangeError(`Invalid date: ${date}`);
  }
  const total = y * 12 + (m - 1) + delta;
  const y2 = Math.floor(total / 12);
  const m2 = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(y2, m2, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${y2}-${pad(m2)}-${pad(Math.min(d, lastDay))}`;
}

/**
 * Monday-first grid covering a calendar month: leading days from the previous
 * month and trailing days from the next, so every row is a full week. Always a
 * multiple of 7 cells.
 */
export function monthGrid(year: number, month: number): string[] {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(`Invalid month: ${year}-${month}`);
  }
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const lead = (firstDow + 6) % 7;
  const lastDow = new Date(Date.UTC(year, month, 0)).getUTCDay();
  const totalDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const trail = 6 - ((lastDow + 6) % 7);
  const start = new Date(Date.UTC(year, month - 1, 1 - lead));
  return Array.from({ length: lead + totalDays + trail }, (_, i) => {
    const dt = new Date(start);
    dt.setUTCDate(start.getUTCDate() + i);
    return dt.toISOString().slice(0, 10);
  });
}
