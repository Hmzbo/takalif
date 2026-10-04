import type { CalendarKind, HijriDate } from '@takalif/core';

/** `0.667` → `"67%"`. `null` (nothing elapsed) renders as an em dash, never `0%`. */
export function formatAdherence(value: number | null): string {
  if (value === null) return '—';
  return `${Math.round(value * 100)}%`;
}

/** `20/30` with the skipped count beside it, so the denominator is never hidden. */
export function formatCounts(done: number, missed: number, skipped: number): string {
  const total = done + missed;
  const base = `${done} / ${total}`;
  return skipped > 0 ? `${base} · ${skipped} skipped` : base;
}

/** `2026-10-04` → `Sat 4 Oct`. Pure formatting; the date itself comes from the server. */
export function formatDayLabel(date: string): string {
  const dt = new Date(`${date}T00:00:00Z`);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return `${days[dt.getUTCDay()]} ${dt.getUTCDate()} ${months[dt.getUTCMonth()]}`;
}

/** Add (or subtract) whole days from a civil date. Display-only arithmetic. */
export function shiftDate(date: string, days: number): string {
  const dt = new Date(`${date}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Today in UTC. The server's `today` (in the user's timezone) wins whenever present. */
export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

const HIJRI_MONTHS = [
  'Muharram', 'Safar', "Rabi' I", "Rabi' II",
  'Jumada I', 'Jumada II', 'Rajab', "Sha'ban",
  'Ramadan', 'Shawwal', "Dhu al-Qa'dah", 'Dhu al-Hijjah',
];

/**
 * Render a date in the user's preferred calendar.
 *
 * Gregorian stays a plain civil date. Hijri renders as e.g. `21 Rabi' II 1448`.
 * The conversion itself lives in core; this only formats.
 */
export function formatCalendarDate(
  date: string,
  calendarDate: HijriDate,
  calendar: CalendarKind,
): string {
  if (calendar === 'gregorian') return formatDayLabel(date);
  const month = HIJRI_MONTHS[calendarDate.month - 1] ?? `month ${calendarDate.month}`;
  return `${calendarDate.day} ${month} ${calendarDate.year}`;
}

export const CALENDAR_OPTIONS: { value: CalendarKind; label: string }[] = [
  { value: 'gregorian', label: 'Gregorian' },
  { value: 'islamic-umalqura', label: 'Hijri · Umm al-Qura' },
  { value: 'islamic-civil', label: 'Hijri · civil' },
  { value: 'islamic-tbla', label: 'Hijri · tabular' },
];

export function calendarLabel(kind: string): string {
  return CALENDAR_OPTIONS.find((o) => o.value === kind)?.label ?? kind;
}
