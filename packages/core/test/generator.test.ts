import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyPlan,
  generatePlan,
  type Exception,
  type GeneratorInput,
  type Occurrence,
  type Rule,
  type RuleVersion,
} from '../src/index.js';
import { newId, NOW, resetIds, rule as r, settings, skipPeriod, version, TODAY } from './helpers.js';

function plan(over: Partial<GeneratorInput> = {}) {
  return generatePlan({
    settings: settings(),
    rules: [],
    versions: [],
    skipPeriods: [],
    exceptions: [],
    occurrences: [],
    now: NOW,
    ...over,
  });
}

function insertedDates(p: ReturnType<typeof plan>, ruleId: string): string[] {
  return p.toInsert
    .filter((o) => o.ruleId === ruleId)
    .map((o) => o.scheduledDate)
    .sort();
}

function insertedCount(p: ReturnType<typeof plan>): number {
  return p.toInsert.length;
}

const DAILY: RuleVersion[] = [version('r1', 1, 'FREQ=DAILY', '2026-01-01')];

beforeEach(resetIds);

// ---------------------------------------------------------------------------

describe('recurrence expansion (golden cases)', () => {
  it('expands a daily rule across the whole window', () => {
    const dates = insertedDates(plan({ rules: [r()], versions: DAILY }), 'r1');
    // lookback 30 / lookahead 14 around 2026-09-30 => 2026-08-31 .. 2026-10-14
    expect(dates[0]).toBe('2026-08-31');
    expect(dates.at(-1)).toBe('2026-10-14');
    expect(dates).toHaveLength(45);
  });

  it('expands every second Tuesday', () => {
    const rrule = 'FREQ=WEEKLY;BYDAY=TU;INTERVAL=2';
    const p = plan({
      rules: [r({ rrule, dtstartDate: '2026-09-01' })],
      versions: [version('r1', 1, rrule, '2026-09-01', '2026-09-01')],
    });
    expect(insertedDates(p, 'r1')).toEqual([
      '2026-09-01',
      '2026-09-15',
      '2026-09-29',
      '2026-10-13',
    ]);
  });

  it('expands the first of every month', () => {
    const p = plan({
      rules: [r({ rrule: 'FREQ=MONTHLY;BYMONTHDAY=1' })],
      versions: [version('r1', 1, 'FREQ=MONTHLY;BYMONTHDAY=1', '2026-01-01')],
    });
    expect(insertedDates(p, 'r1')).toEqual(['2026-09-01', '2026-10-01']);
  });

  it('expands the last Friday of every month (BYSETPOS)', () => {
    const rrule = 'FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1';
    // The default 14-day lookahead only reaches October's 14th, so widen it
    // far enough to contain October's last Friday.
    const p = plan({
      settings: settings({ lookaheadDays: 45 }),
      rules: [r({ rrule })],
      versions: [version('r1', 1, rrule, '2026-01-01')],
    });
    expect(insertedDates(p, 'r1')).toEqual(['2026-09-25', '2026-10-30']);
  });

  it('skips months without a 31st rather than clamping', () => {
    // The classic RRULE trap: the 31st must not become Feb 28.
    const rrule = 'FREQ=MONTHLY;BYMONTHDAY=31';
    const p = plan({
      settings: settings({ lookbackDays: 200, lookaheadDays: 60 }),
      rules: [r({ rrule, dtstartDate: '2026-01-31' })],
      versions: [version('r1', 1, rrule, '2026-01-31', '2026-01-31')],
    });
    const dates = insertedDates(p, 'r1');
    expect(dates).toEqual([
      '2026-03-31',
      '2026-05-31',
      '2026-07-31',
      '2026-08-31',
      '2026-10-31',
    ]);
    expect(dates.some((d) => d.startsWith('2026-02'))).toBe(false);
  });

  it('expands weekdays only', () => {
    const rrule = 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
    const p = plan({ rules: [r({ rrule })], versions: [version('r1', 1, rrule, '2026-01-01')] });
    const dates = insertedDates(p, 'r1');
    expect(dates.length).toBeGreaterThan(0);
    for (const d of dates) {
      const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
      expect(dow).toBeGreaterThanOrEqual(1);
      expect(dow).toBeLessThanOrEqual(5);
    }
  });

  it('honours EXDATE in the rule string and the exceptions table', () => {
    const exc: Exception = { ruleId: 'r2', date: '2026-09-16' };
    const p = plan({
      rules: [r({ rrule: 'FREQ=DAILY;EXDATE:20260915' }), r({ id: 'r2' })],
      versions: [
        version('r1', 1, 'FREQ=DAILY;EXDATE:20260915', '2026-01-01'),
        version('r2', 1, 'FREQ=DAILY', '2026-01-01'),
      ],
      exceptions: [exc],
    });
    expect(insertedDates(p, 'r1')).not.toContain('2026-09-15');
    expect(insertedDates(p, 'r2')).not.toContain('2026-09-16');
  });
});

// ---------------------------------------------------------------------------

describe('skip periods', () => {
  it('materialises occurrences inside a skip period as skipped, not pending', () => {
    const p = plan({
      rules: [r()],
      versions: DAILY,
      skipPeriods: [skipPeriod('2026-09-10', '2026-09-12')],
    });
    const inSpan = p.toInsert.filter(
      (o) => o.scheduledDate >= '2026-09-10' && o.scheduledDate <= '2026-09-12',
    );
    expect(inSpan).toHaveLength(3);
    expect(inSpan.every((o) => o.status === 'skipped')).toBe(true);
  });

  it('never overwrites a completion made during a skip period', () => {
    // The user kept training while away. That must stay a success.
    const doneOnHoliday: Occurrence = {
      id: 'o-holiday',
      ruleId: 'r1',
      ruleVersion: 1,
      scheduledDate: '2026-09-11',
      status: 'done',
      completedAt: '2026-09-11T07:00:00.000Z',
    };
    const p = plan({
      rules: [r()],
      versions: DAILY,
      skipPeriods: [skipPeriod('2026-09-10', '2026-09-12')],
      occurrences: [doneOnHoliday],
    });
    expect([...p.toUpdate, ...p.sweep].filter((u) => u.id === 'o-holiday')).toHaveLength(0);
  });

  it('applies a skip period created after rows were already materialised', () => {
    const p = plan({
      rules: [r()],
      versions: DAILY,
      skipPeriods: [skipPeriod('2026-09-19', '2026-09-21')],
      occurrences: [
        { id: 'o1', ruleId: 'r1', ruleVersion: 1, scheduledDate: '2026-09-20', status: 'pending' },
      ],
    });
    expect(p.toUpdate).toContainEqual({ id: 'o1', status: 'skipped' });
  });
});

// ---------------------------------------------------------------------------

describe('sweeping and the day boundary', () => {
  it('marks elapsed untouched occurrences as missed', () => {
    const p = plan({
      rules: [r()],
      versions: DAILY,
      occurrences: [
        { id: 'o1', ruleId: 'r1', ruleVersion: 1, scheduledDate: '2026-09-25', status: 'pending' },
      ],
    });
    expect(p.sweep).toContainEqual({
      id: 'o1',
      ruleId: 'r1',
      scheduledDate: '2026-09-25',
      status: 'missed',
    });
  });

  it("does not sweep today's occurrence", () => {
    const p = plan({
      rules: [r()],
      versions: DAILY,
      occurrences: [
        { id: 'o1', ruleId: 'r1', ruleVersion: 1, scheduledDate: TODAY, status: 'pending' },
      ],
    });
    expect(p.sweep).toHaveLength(0);
  });

  it('keeps last night open until the rollover, not local midnight', () => {
    // 02:00 with a 04:00 rollover: yesterday is still open, so a task done at
    // 23:00 is not a failure.
    const p = plan({
      rules: [r()],
      versions: DAILY,
      occurrences: [
        { id: 'o1', ruleId: 'r1', ruleVersion: 1, scheduledDate: '2026-09-29', status: 'pending' },
      ],
      now: new Date('2026-09-30T02:00:00.000Z'),
    });
    expect(p.sweep).toHaveLength(0);
  });

  it('sweeps yesterday once the rollover has passed', () => {
    const p = plan({
      rules: [r()],
      versions: DAILY,
      occurrences: [
        { id: 'o1', ruleId: 'r1', ruleVersion: 1, scheduledDate: '2026-09-29', status: 'pending' },
      ],
      now: new Date('2026-09-30T05:00:00.000Z'),
    });
    expect(p.sweep).toHaveLength(1);
  });

  it('honours a non-default rollover time', () => {
    const p = plan({
      settings: settings({ dayRollover: '23:00' }),
      rules: [r()],
      versions: DAILY,
      occurrences: [
        { id: 'o1', ruleId: 'r1', ruleVersion: 1, scheduledDate: '2026-09-29', status: 'pending' },
      ],
      now: new Date('2026-09-29T23:30:00.000Z'),
    });
    expect(p.sweep).toHaveLength(0);
  });

  it('materialises already-elapsed dates directly as missed', () => {
    // Widening the lookback window must not leave a stale pending backlog.
    const p = plan({ rules: [r()], versions: DAILY });
    const past = p.toInsert.filter((o) => o.scheduledDate < TODAY);
    expect(past.length).toBeGreaterThan(0);
    expect(past.every((o) => o.status === 'missed')).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('invariants', () => {
  const rules: Rule[] = [r()];
  const versions = DAILY;

  it('is idempotent: a second run over unchanged state does no work', () => {
    const stored = applyPlan(plan({ rules, versions }), [], newId);
    const second = plan({ rules, versions, occurrences: stored });
    expect(second.toInsert).toHaveLength(0);
    expect(second.toUpdate).toHaveLength(0);
    expect(second.toDelete).toHaveLength(0);
    expect(second.sweep).toHaveLength(0);
  });

  it('never proposes (ruleId, date) twice', () => {
    const keys = plan({ rules, versions }).toInsert.map((o) => `${o.ruleId}|${o.scheduledDate}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('never modifies a terminal occurrence', () => {
    const terminal: Occurrence[] = (['2026-09-20', '2026-09-21', '2026-09-22'] as const).map(
      (d, i) => ({
        id: `o${i}`,
        ruleId: 'r1',
        ruleVersion: 1,
        scheduledDate: d,
        status: (i === 0 ? 'done' : i === 1 ? 'missed' : 'skipped') as Occurrence['status'],
        completedAt: i === 0 ? '2026-09-20T07:00:00.000Z' : null,
      }),
    );
    const p = plan({ rules, versions, occurrences: terminal });
    expect([...p.toUpdate, ...p.sweep].map((u) => u.id)).toHaveLength(0);
    expect(p.toDelete).toHaveLength(0);
  });

  it('does not depend on the host machine timezone', () => {
    const original = process.env.TZ;
    const run = () =>
      plan({ rules, versions })
        .toInsert.map((o) => o.scheduledDate)
        .join(',');
    try {
      process.env.TZ = 'Pacific/Kiritimati';
      const a = run();
      process.env.TZ = 'America/Anchorage';
      const b = run();
      expect(a).toBe(b);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it('resolves today from the configured zone, not the host zone', () => {
    // 23:30 UTC is already the 1st in Warsaw.
    const late = new Date('2026-09-30T23:30:00.000Z');
    expect(plan({ settings: settings({ timezone: 'Europe/Warsaw' }), rules, versions, now: late }).today).toBe(
      '2026-10-01',
    );
    expect(plan({ rules, versions, now: late }).today).toBe('2026-09-30');
  });

  it('isolates one malformed rule from the rest of the ledger', () => {
    const p = plan({
      rules: [r({ id: 'r1' }), r({ id: 'bad', title: 'Broken' })],
      versions: [version('r1', 1, 'FREQ=DAILY', '2026-01-01'), version('bad', 1, 'NOT-A-RRULE', '2026-01-01')],
    });
    expect(insertedDates(p, 'r1').length).toBeGreaterThan(0);
    expect(p.failedRules).toHaveLength(1);
    expect(p.failedRules[0]?.ruleId).toBe('bad');
  });

  it('ignores archived rules', () => {
    expect(plan({ rules: [r({ active: false })], versions }).toInsert).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('schedule versioning: history must survive edits', () => {
  /** Settled rows across Feb-Jun, as if the user had been using it for months. */
  const historical: Occurrence[] = (() => {
    const out: Occurrence[] = [];
    let n = 0;
    for (let d = new Date(Date.UTC(2026, 1, 1)); d <= new Date(Date.UTC(2026, 5, 30)); ) {
      const date = d.toISOString().slice(0, 10);
      n += 1;
      out.push({
        id: `hist-${n}`,
        ruleId: 'r1',
        ruleVersion: 1,
        scheduledDate: date,
        status: n % 3 === 0 ? 'missed' : 'done',
        completedAt: n % 3 === 0 ? null : `${date}T07:00:00.000Z`,
      });
      d = new Date(d.getTime() + 86_400_000);
    }
    return out;
  })();

  it('does not reinterpret past occurrences when the schedule is loosened', () => {
    // The money test: loosen DAILY to the 1st of each month, effective 2026-04-01.
    const p = plan({
      settings: settings({ lookbackDays: 400, lookaheadDays: 60 }),
      rules: [r()],
      versions: [
        version('r1', 1, 'FREQ=DAILY', '2026-01-01'),
        version('r1', 2, 'FREQ=MONTHLY;BYMONTHDAY=1', '2026-04-01'),
      ],
      occurrences: historical,
    });

    const touched = new Set([...p.toUpdate, ...p.sweep].map((u) => u.id));
    const deleted = new Set(p.toDelete.map((d) => d.id));
    for (const occ of historical) {
      expect(touched.has(occ.id)).toBe(false);
      expect(deleted.has(occ.id)).toBe(false);
    }

    const inserted = p.toInsert.filter((o) => o.scheduledDate >= '2026-04-01');
    expect(inserted.length).toBeGreaterThan(0);
    expect(inserted.every((o) => o.ruleVersion === 2)).toBe(true);
  });

  it('attributes rows before the edit to the old version and after to the new one', () => {
    const p = plan({
      rules: [r()],
      versions: [
        version('r1', 1, 'FREQ=DAILY', '2026-01-01'),
        version('r1', 2, 'FREQ=WEEKLY;BYDAY=MO', '2026-09-20'),
      ],
    });
    const before = p.toInsert.filter((o) => o.scheduledDate < '2026-09-20');
    const after = p.toInsert.filter((o) => o.scheduledDate >= '2026-09-20');
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((o) => o.ruleVersion === 1)).toBe(true);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((o) => o.ruleVersion === 2)).toBe(true);
  });

  it('drops future rows the new schedule no longer includes', () => {
    // Materialise under the daily schedule first, so there is something to withdraw.
    const v1 = [version('r1', 1, 'FREQ=DAILY', '2026-01-01')];
    const stored = applyPlan(plan({ rules: [r()], versions: v1 }), [], newId);

    // Then loosen to every Monday, effective today.
    const p = plan({
      rules: [r()],
      versions: [version('r1', 1, 'FREQ=DAILY', '2026-01-01'), version('r1', 2, 'FREQ=WEEKLY;BYDAY=MO', TODAY)],
      occurrences: stored,
    });

    const deleted = new Set(p.toDelete.map((d) => d.scheduledDate));
    expect(deleted.size).toBeGreaterThan(0);
    for (const d of deleted) {
      expect(d > TODAY).toBe(true);
      expect(new Date(`${d}T00:00:00Z`).getUTCDay()).not.toBe(1);
    }
    // Future Mondays that the new schedule still calls for must survive.
    for (const monday of ['2026-10-05', '2026-10-12']) {
      expect(deleted.has(monday)).toBe(false);
    }
  });

  it('neutralises past pending rows the new schedule dropped', () => {
    const p = plan({
      rules: [r()],
      versions: [
        version('r1', 1, 'FREQ=DAILY', '2026-01-01'),
        version('r1', 2, 'FREQ=MONTHLY;BYMONTHDAY=1', '2026-09-20'),
      ],
      occurrences: [
        { id: 'orphan', ruleId: 'r1', ruleVersion: 1, scheduledDate: '2026-09-25', status: 'pending' },
      ],
    });
    expect(p.toUpdate).toContainEqual({ id: 'orphan', status: 'skipped', note: 'schedule changed' });
    expect(p.toDelete).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('recovery prompt', () => {
  it('stays quiet for a rule created today', () => {
    // Nothing is materialised before the rule existed, so a fresh install does
    // not greet you with a month of failures.
    const p = plan({
      rules: [r({ createdDate: TODAY })],
      versions: DAILY,
    });
    expect(p.recoveryPrompt).toBeNull();
    expect(insertedDates(p, 'r1').filter((d) => d <= TODAY)).toEqual([TODAY]);
  });

  it('does not fabricate history before a rule was created', () => {
    const p = plan({ rules: [r({ createdDate: '2026-09-28' })], versions: DAILY });
    const dates = insertedDates(p, 'r1');
    expect(dates[0]).toBe('2026-09-28');
    expect(dates.at(-1)).toBe('2026-10-14');
    expect(dates.some((d) => d < '2026-09-28')).toBe(false);
  });

  it('offers an out after a long absence', () => {
    const p = plan({
      rules: [r()],
      versions: DAILY,
      settings: settings({ lookbackDays: 90 }),
    });
    expect(p.recoveryPrompt).not.toBeNull();
    expect(p.recoveryPrompt?.count).toBeGreaterThanOrEqual(14);
    expect(p.recoveryPrompt?.from).toBe('2026-07-02');
    expect(p.recoveryPrompt?.to).toBe('2026-09-29');
  });
});

// ---------------------------------------------------------------------------

describe('window construction', () => {
  it('honours asymmetric lookback and lookahead', () => {
    const p = plan({
      rules: [r()],
      versions: DAILY,
      settings: settings({ lookbackDays: 10, lookaheadDays: 5 }),
    });
    expect(p.window.from).toBe('2026-09-20');
    expect(p.window.to).toBe('2026-10-05');
    expect(insertedCount(p)).toBe(16);
  });

  it('tolerates a zero-length window', () => {
    const p = plan({
      rules: [r()],
      versions: DAILY,
      settings: settings({ lookbackDays: 0, lookaheadDays: 0 }),
    });
    expect(insertedDates(p, 'r1')).toEqual([TODAY]);
  });
});
