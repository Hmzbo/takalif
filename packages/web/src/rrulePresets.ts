/**
 * Schedule presets for the rule form.
 *
 * The form never asks the user to write RRULE by hand (unless they choose
 * "Custom"). Each preset builds a bare RRULE value; the `CALENDAR=` qualifier
 * is appended separately by the caller when the rule uses a Hijri calendar.
 *
 * Kept pure and tested: building the string is presentation, but a wrong
 * string silently creates a wrong schedule, so it gets the same treatment as
 * domain code.
 */

export type WeekdayKey = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

export const WEEKDAYS: { key: WeekdayKey; label: string }[] = [
  { key: 'MO', label: 'Mon' },
  { key: 'TU', label: 'Tue' },
  { key: 'WE', label: 'Wed' },
  { key: 'TH', label: 'Thu' },
  { key: 'FR', label: 'Fri' },
  { key: 'SA', label: 'Sat' },
  { key: 'SU', label: 'Sun' },
];

export type PresetKind = 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';

export const PRESETS: { kind: PresetKind; label: string; hint: string }[] = [
  { kind: 'daily', label: 'Every day', hint: 'Once per calendar day' },
  { kind: 'weekdays', label: 'Weekdays', hint: 'Monday to Friday' },
  { kind: 'weekly', label: 'Weekly', hint: 'On chosen days of the week' },
  { kind: 'monthly', label: 'Monthly', hint: 'On chosen days of the month' },
  { kind: 'custom', label: 'Custom', hint: 'Write the RRULE yourself' },
];

const DAY_ORDER: Record<WeekdayKey, number> = {
  MO: 0,
  TU: 1,
  WE: 2,
  TH: 3,
  FR: 4,
  SA: 5,
  SU: 6,
};

function sortedDays(days: WeekdayKey[]): WeekdayKey[] {
  return [...days].sort((a, b) => DAY_ORDER[a] - DAY_ORDER[b]);
}

export interface PresetInput {
  kind: PresetKind;
  /** For `weekly`: which days. Defaults to Monday when empty. */
  days?: WeekdayKey[];
  /** For `monthly`: which days of the month (1–31). Defaults to the 1st. */
  monthDays?: number[];
  /** Every N days / weeks / months. Defaults to 1. */
  interval?: number;
  /** For `custom`: the raw value. */
  custom?: string;
}

/** Build a bare RRULE value (no `CALENDAR=`, no `EXDATE`) from a preset. */
export function buildRRule(input: PresetInput): string {
  const interval = Math.max(1, Math.floor(input.interval ?? 1));

  switch (input.kind) {
    case 'daily':
      return interval === 1 ? 'FREQ=DAILY' : `FREQ=DAILY;INTERVAL=${interval}`;
    case 'weekdays':
      return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
    case 'weekly': {
      const days = sortedDays(input.days?.length ? input.days : ['MO']);
      const byday = `BYDAY=${days.join(',')}`;
      return interval === 1 ? `FREQ=WEEKLY;${byday}` : `FREQ=WEEKLY;INTERVAL=${interval};${byday}`;
    }
    case 'monthly': {
      const days = [...new Set((input.monthDays?.length ? input.monthDays : [1]).map((d) => Math.min(31, Math.max(1, Math.floor(d)))))].sort(
        (a, b) => a - b,
      );
      const bymonthday = `BYMONTHDAY=${days.join(',')}`;
      return interval === 1 ? `FREQ=MONTHLY;${bymonthday}` : `FREQ=MONTHLY;INTERVAL=${interval};${bymonthday}`;
    }
    case 'custom':
      return (input.custom ?? '').trim();
  }
}

/** One-line human description of an RRULE value, for lists and previews. */
export function describeRRule(rrule: string): string {
  const upper = rrule.toUpperCase();
  const interval = /INTERVAL=(\d+)/.exec(upper)?.[1];

  const every = interval && interval !== '1' ? `Every ${interval} ` : 'Every ';
  if (upper.startsWith('FREQ=DAILY')) {
    if (interval === undefined || interval === '1') return 'Every day';
    return `${every}days`;
  }
  if (/BYDAY=MO,TU,WE,TH,FR/.test(upper)) return 'Weekdays';
  const byday = /BYDAY=([A-Z,]+)/.exec(upper)?.[1];
  if (upper.startsWith('FREQ=WEEKLY') && byday) {
    const labels = byday
      .split(',')
      .map((d) => WEEKDAYS.find((w) => w.key === d)?.label ?? d)
      .join(', ');
    const unit = interval && interval !== '1' ? 'weeks' : 'week';
    return `${every}${unit} · ${labels}`;
  }
  const bymonthday = /BYMONTHDAY=([-\d,]+)/.exec(upper)?.[1];
  if (upper.startsWith('FREQ=MONTHLY') && bymonthday) {
    const days = bymonthday.split(',').map((d) => ordinal(Number(d))).join(', ');
    const unit = interval && interval !== '1' ? 'months' : 'month';
    return `${every}${unit} · ${days}`;
  }
  return rrule;
}

function ordinal(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const suffix = n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

/** Parse a comma-separated month-day field ("1, 15") into numbers. */
export function parseMonthDays(text: string): number[] {
  return [...new Set(
    text
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 31),
  )].sort((a, b) => a - b);
}
