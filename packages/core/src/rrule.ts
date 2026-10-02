import { RRule } from 'rrule';
import { formatDate, parseDate, type LocalDate } from './dates.js';

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
  }): LocalDate[];
}

export class InvalidRRuleError extends Error {
  constructor(
    rrule: string,
    override readonly cause: unknown,
  ) {
    super(`Invalid RRULE: ${rrule}`);
    this.name = 'InvalidRRuleError';
  }
}

/**
 * Expand an RFC 5545 recurrence over an inclusive date range.
 *
 * The RRULE is a bare value (`FREQ=WEEKLY;BYDAY=TU;INTERVAL=2`), with DTSTART
 * supplied separately. All dates are handled as UTC-midnight carriers, which
 * means a daylight-saving transition cannot shift an occurrence by a day.
 */
export const expandRRule: RRuleExpander = ({ rrule, dtstart, from, to }) => {
  if (from > to) return [];

  let options: Partial<ConstructorParameters<typeof RRule>[0]>;
  try {
    options = RRule.parseString(rrule.trim());
  } catch (error) {
    throw new InvalidRRuleError(rrule, error);
  }

  let rule: RRule;
  try {
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
 * Validate an RRULE without expanding it, so the API can reject a bad rule at
 * creation time instead of silently dropping occurrences later.
 */
export function validateRRule(rrule: string, dtstart: LocalDate): boolean {
  try {
    const options = RRule.parseString(rrule.trim());
    // Constructing forces semantic validation (bad BYDAY, COUNT<=0, etc.).
    new RRule({ ...options, dtstart: parseDate(dtstart) });
    return true;
  } catch {
    return false;
  }
}
