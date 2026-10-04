import * as rruleNamespace from 'rrule';
import { formatDate, parseDate, type LocalDate } from './dates.js';
import {
  hijriMonthLength,
  isHijri,
  toGregorian,
  toHijri,
  type CalendarKind,
} from './calendars.js';

/**
 * `rrule` ships as CommonJS. Node's ESM named-export detection cannot see
 * `RRule`, because the published `dist/es5` bundle is a webpack wrapper whose
 * `module.exports = factory()` is not statically analysable. Bundlers instead
 * resolve the `module` field to a real ESM build that *does* have named
 * exports and no `default`.
 *
 * So: prefer `default.RRule` (Node ESM), fall back to `RRule` (bundler). The
 * cast goes through `unknown` so it typechecks under both `bundler` and
 * `NodeNext` module resolution.
 */
type RRuleCtor = typeof rruleNamespace.RRule;

const rruleModule = rruleNamespace as unknown as {
  default?: { RRule?: RRuleCtor };
  RRule?: RRuleCtor;
};

const resolved = (rruleModule.default?.RRule ?? rruleModule.RRule) as
  | RRuleCtor
  | undefined;

if (typeof resolved !== 'function') {
  // Fail loudly at import time. A broken interop would otherwise surface as
  // "every RRULE is invalid", which looks like user input error.
  throw new Error(
    'rrule: could not resolve the RRule constructor from the module namespace',
  );
}

const RRule: RRuleCtor = resolved;

/**
 * The single seam between our domain and an RRULE implementation.
 *
 * Nothing else in `core` imports an RRULE library. This keeps the generator
 * testable and lets us swap `rrule.js` for a Temporal-based implementation
 * later without touching a line of scheduling logic.
 */
export interface RRuleExpander {
  (options: {
    rrule: string;
    dtstart: LocalDate;
    from: LocalDate;
    to: LocalDate;
    /** Interprets month/day anchors in this calendar. Defaults to Gregorian. */
    calendar?: CalendarKind;
  }): LocalDate[];
}

export class InvalidRRuleError extends Error {
  readonly rrule: string;

  constructor(rrule: string, cause?: unknown) {
    super(`Invalid RRULE: ${rrule}`);
    this.name = 'InvalidRRuleError';
    this.rrule = rrule;
    // Assigned rather than a TS parameter property, so the class body is
    // erasable-syntax only and stays loadable under Node's type stripping.
    this.cause = cause;
  }
}

/**
 * Split off `EXDATE` entries before handing the rule to the parser.
 *
 * `RRule.parseString` rejects any property it does not recognise, and `EXDATE`
 * is an RFC 5545 *property*, not an RRULE part. A rule carrying an exclusion
 * date would otherwise be rejected as invalid, even though we support
 * exclusions — the generator merges them in separately.
 *
 * The same applies to `CALENDAR=`, which is our own extension (see the
 * multi-calendar ADR) and is likewise not an RRULE part.
 */
export function splitExDates(rule: string): {
  rule: string;
  exdates: string[];
} {
  const exdates: string[] = [];
  const stripped = rule
    .split(';')
    .filter((part) => {
      if (!/^EXDATE/i.test(part)) return true;
      const value = part.slice(part.indexOf(':') + 1);
      for (const token of value.split(',')) {
        const compact = token.replace(/[^0-9]/g, '');
        if (compact.length !== 8) continue;
        exdates.push(
          `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`,
        );
      }
      return false;
    })
    .join(';');
  return { rule: stripped, exdates };
}

/**
 * Read a `CALENDAR=` qualifier out of an RRULE and return the rule without it.
 *
 * `gregorian` means the qualifier was absent, which is the default: every rule
 * that predates multi-calendar support behaves exactly as it did before.
 */
export function parseCalendarQualifier(
  rule: string,
): { rule: string; calendar: CalendarKind } {
  let calendar: CalendarKind = 'gregorian';
  const stripped = rule
    .split(';')
    .filter((part) => {
      const m = /^CALENDAR=(.+)$/i.exec(part.trim());
      if (!m?.[1]) return true;
      const value = m[1].trim().toUpperCase().replace(/-/g, '_');
      let resolved: CalendarKind;
      switch (value) {
        case 'GREGORIAN':
          resolved = 'gregorian';
          break;
        case 'ISLAMIC_UMALQURA':
        case 'ISLAMIC':
          resolved = 'islamic-umalqura';
          break;
        case 'ISLAMIC_CIVIL':
          resolved = 'islamic-civil';
          break;
        case 'ISLAMIC_TBLA':
          resolved = 'islamic-tbla';
          break;
        default:
          throw new Error(`Unsupported calendar qualifier: ${m[1]}`);
      }
      calendar = resolved;
      return false;
    })
    .join(';');
  return { rule: stripped, calendar };
}

/** Which parts of an RRULE are interpreted in the rule's own calendar? */
export function isCalendarSensitive(rrule: string): boolean {
  const upper = rrule.toUpperCase();
  return /BYMONTHDAY/.test(upper) || /BYSETPOS/.test(upper) || /BYMONTH/.test(upper);
}

/**
 * Expand an RFC 5545 recurrence over an inclusive date range.
 *
 * The RRULE is a bare value (`FREQ=WEEKLY;BYDAY=TU;INTERVAL=2`), with DTSTART
 * supplied separately. All dates are handled as UTC-midnight carriers, which
 * means a daylight-saving transition cannot shift an occurrence by a day.
 *
 * For a Hijri calendar, the month and day anchors are interpreted *in that
 * calendar* and converted back to Gregorian civil dates, which is what the
 * ledger is keyed on.
 */
export const expandRRule: RRuleExpander = ({ rrule, dtstart, from, to, calendar }) => {
  if (from > to) return [];
  const kind = calendar ?? 'gregorian';

  if (isHijri(kind) && isCalendarSensitive(rrule)) {
    return expandHijri({ rrule, dtstart, from, to, calendar: kind });
  }

  let rule: InstanceType<RRuleCtor>;
  try {
    // The CALENDAR qualifier is our own extension and not an RRULE part, so it
    // must come off before parsing — including for a Hijri rule that happens
    // to use only calendar-insensitive anchors like BYDAY.
    const { rule: withoutExdates } = splitExDates(rrule.trim());
    const { rule: withoutCalendar } = parseCalendarQualifier(withoutExdates);
    const options = RRule.parseString(withoutCalendar);
    // Constructing forces semantic validation (bad BYDAY, COUNT<=0, etc.).
    rule = new RRule({ ...options, dtstart: parseDate(dtstart) });
  } catch (error) {
    throw new InvalidRRuleError(rrule, error);
  }

  let dates: Date[];
  try {
    dates = rule.between(parseDate(from), parseDate(to), true);
  } catch (error) {
    throw new InvalidRRuleError(rrule, error);
  }

  return dates.map(formatDate);
};

/**
 * Expand a month- or day-anchored rule in the Hijri calendar.
 *
 * Hijri months are 29 or 30 days, so an anchor such as day 30 must skip the
 * short months rather than be clamped — exactly what `BYMONTHDAY=31` already
 * does in Gregorian.
 */
function expandHijri({
  rrule,
  dtstart,
  from,
  to,
  calendar,
}: {
  rrule: string;
  dtstart: LocalDate;
  from: LocalDate;
  to: LocalDate;
  calendar: CalendarKind;
}): LocalDate[] {
  const { rule: clean, exdates: ruleExdates } = splitExDates(rrule.trim());
  const { rule: withoutCalendar } = parseCalendarQualifier(clean);
  const options = RRule.parseString(withoutCalendar);

  const monthdays = parseMonthDays(withoutCalendar);
  const bySetPos = parseBySetPos(withoutCalendar);
  const byDays = parseByDays(withoutCalendar);

  const out: LocalDate[] = [];
  const excluded = new Set(ruleExdates);

  // Walk Hijri months that overlap the window. The walk starts from the month
  // the window opens in, so a window beginning mid-month still covers that
  // month's earlier days.
  const start = toHijri(from, calendar);
  const cursor = { year: start.year, month: start.month };
  const limit = 24; // 24 months comfortably exceeds any lookahead

  for (let i = 0; i < limit; i++) {
    const length = hijriMonthLength(cursor.year, cursor.month, calendar);
    if (length === 0) break;

    // First and last Gregorian date of this Hijri month.
    const firstG = toGregorian({ ...cursor, day: 1 }, calendar);
    const lastG = toGregorian({ ...cursor, day: length }, calendar);
    if (firstG === null || lastG === null) break;

    if (firstG > to) break; // walked past the window
    if (lastG >= from) {
      if (bySetPos !== null && byDays.length > 0) {
        // "Last Friday of the Hijri month" — collect the month's dates that
        // match a weekday, then index from either end.
        const matching: LocalDate[] = [];
        let d = firstG;
        while (d <= lastG) {
          if (byDays.includes(new Date(`${d}T00:00:00Z`).getUTCDay())) matching.push(d);
          d = formatDate(new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000));
        }
        const index = bySetPos > 0 ? bySetPos - 1 : matching.length + bySetPos;
        const chosen = matching[index];
        if (chosen !== undefined && chosen >= from && chosen <= to && !excluded.has(chosen)) {
          out.push(chosen);
        }
      } else {
        // Plain BYMONTHDAY anchors.
        for (const day of monthdays) {
          if (day > length) continue; // skip, never clamp
          const g = toGregorian({ ...cursor, day }, calendar);
          if (g === null) continue;
          if (g < from || g > to) continue;
          if (excluded.has(g)) continue;
          out.push(g);
        }
      }
    }

    cursor.month++;
    if (cursor.month > 12) {
      cursor.month = 1;
      cursor.year++;
    }
  }

  return out.sort();
}

function parseMonthDays(rrule: string): number[] {
  const m = /BYMONTHDAY=(-?\d+(?:,-?\d+)*)/i.exec(rrule);
  if (!m?.[1]) return [];
  return m[1].split(',').map(Number);
}

function parseBySetPos(rrule: string): number | null {
  const m = /BYSETPOS=(-?\d+)/i.exec(rrule);
  return m?.[1] ? Number(m[1]) : null;
}

function parseByDays(rrule: string): number[] {
  const m = /BYDAY=([A-Z,]+)/i.exec(rrule);
  if (!m?.[1]) return [];
  const map: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  return m[1]
    .split(',')
    .map((d) => map[d.trim().toUpperCase()])
    .filter((n) => n !== undefined);
}

/**
 * Validate an RRULE without expanding it, so the API can reject a bad rule at
 * creation time instead of silently dropping occurrences later.
 */
export function validateRRule(rule: string, dtstart: LocalDate): boolean {
  try {
    const { rule: withoutExdates } = splitExDates(rule.trim());
    const { rule: withoutCalendar } = parseCalendarQualifier(withoutExdates);
    const options = RRule.parseString(withoutCalendar);
    new RRule({ ...options, dtstart: parseDate(dtstart) });
    return true;
  } catch {
    return false;
  }
}