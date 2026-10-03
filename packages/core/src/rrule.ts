import * as rruleNamespace from 'rrule';
import { formatDate, parseDate, type LocalDate } from './dates.js';

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
 */
export function splitExDates(rule: string): { rule: string; exdates: string[] } {
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
 * Expand an RFC 5545 recurrence over an inclusive date range.
 *
 * The RRULE is a bare value (`FREQ=WEEKLY;BYDAY=TU;INTERVAL=2`), with DTSTART
 * supplied separately. All dates are handled as UTC-midnight carriers, which
 * means a daylight-saving transition cannot shift an occurrence by a day.
 */
export const expandRRule: RRuleExpander = ({ rrule, dtstart, from, to }) => {
  if (from > to) return [];

  let rule: InstanceType<RRuleCtor>;
  try {
    const { rule: withoutExdates } = splitExDates(rrule.trim());
    const options = RRule.parseString(withoutExdates);
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
}

/**
 * Validate an RRULE without expanding it, so the API can reject a bad rule at
 * creation time instead of silently dropping occurrences later.
 */
export function validateRRule(rule: string, dtstart: LocalDate): boolean {
  try {
    const { rule: withoutExdates } = splitExDates(rule.trim());
    const options = RRule.parseString(withoutExdates);
    new RRule({ ...options, dtstart: parseDate(dtstart) });
    return true;
  } catch {
    return false;
  }
}