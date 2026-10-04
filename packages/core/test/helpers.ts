import type {
  Occurrence,
  OccurrenceStatus,
  Rule,
  RuleVersion,
  Settings,
  SkipPeriod,
} from '../src/index.js';

/** Fixed clock: midday on 2026-09-30. */
export const NOW = new Date('2026-09-30T12:00:00.000Z');
export const TODAY = '2026-09-30';
export const TZ = 'UTC';

let counter = 0;
export function resetIds(): void {
  counter = 0;
}
export function newId(): string {
  counter += 1;
  return `occ-${counter}`;
}

export function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    timezone: TZ,
    dayRollover: '04:00',
    lookbackDays: 30,
    lookaheadDays: 14,
    defaultCalendar: 'gregorian' as const,
    email: null,
    ...overrides,
  };
}

export function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: 'r1',
    title: 'Workout',
    description: null,
    rrule: 'FREQ=DAILY',
    dtstartDate: '2026-01-01',
    dueTime: null,
    calendar: 'gregorian' as const,
    createdDate: '2026-01-01',
    trackStreak: false,
    category: null,
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function version(
  ruleId: string,
  n: number,
  rrule: string,
  effectiveFrom: string,
  dtstartDate = '2026-01-01',
): RuleVersion {
  return {
    id: `v${n}`,
    ruleId,
    version: n,
    rrule,
    dtstartDate,
    effectiveFrom,
    createdAt: `${effectiveFrom}T00:00:00.000Z`,
  };
}

export function occurrence(overrides: Partial<Occurrence> = {}): Occurrence {
  return {
    id: 'o1',
    ruleId: 'r1',
    ruleVersion: 1,
    scheduledDate: TODAY,
    dueTime: null,
    status: 'pending' as OccurrenceStatus,
    completedAt: null,
    note: null,
    ...overrides,
  };
}

export function skipPeriod(
  startDate: string,
  endDate: string,
  overrides: Partial<SkipPeriod> = {},
): SkipPeriod {
  return { id: 'sp1', startDate, endDate, reason: 'holiday', ...overrides };
}
