import { describe, expect, it } from 'vitest';
import {
  buildReport,
  computeStreak,
  countOccurrences,
  summarise,
  type Occurrence,
} from '../src/index.js';
import { settings, TODAY } from './helpers.js';

let n = 0;
function occ(overrides: Partial<Occurrence> & { status: Occurrence['status'] }): Occurrence {
  n += 1;
  return {
    id: `o${n}`,
    ruleId: 'r1',
    ruleVersion: 1,
    scheduledDate: TODAY,
    completedAt: null,
    ...overrides,
  };
}

const S = settings();

describe('counting', () => {
  it('excludes pending from elapsed', () => {
    const counts = countOccurrences([
      occ({ status: 'done' }),
      occ({ status: 'missed' }),
      occ({ status: 'skipped' }),
      occ({ status: 'pending' }),
    ]);
    expect(counts).toMatchObject({ done: 1, missed: 1, skipped: 1, pending: 1, elapsed: 3, total: 4 });
  });
});

describe('adherence', () => {
  it('is done over done-plus-missed, excluding skips', () => {
    // The vacation case: 20 done, 10 missed, holiday days not counted against you.
    const rows = [
      ...Array.from({ length: 20 }, () => occ({ status: 'done' })),
      ...Array.from({ length: 10 }, () => occ({ status: 'missed' })),
    ];
    const s = summarise(rows, { today: TODAY, settings: S });
    expect(s.adherence).toBeCloseTo(20 / 30, 6);
  });

  it('ignores skipped occurrences in the denominator', () => {
    const withSkip = summarise(
      [...Array.from({ length: 8 }, () => occ({ status: 'done' })), occ({ status: 'skipped' })],
      { today: TODAY, settings: S },
    );
    const withoutSkip = summarise(
      Array.from({ length: 8 }, () => occ({ status: 'done' })),
      { today: TODAY, settings: S },
    );
    expect(withSkip.adherence).toBe(withoutSkip.adherence);
    expect(withSkip.counts.elapsed).toBe(9);
  });

  it('reports the skipped count so the denominator is never hidden', () => {
    const s = summarise(
      [...Array.from({ length: 8 }, () => occ({ status: 'done' })), occ({ status: 'skipped' })],
      { today: TODAY, settings: S },
    );
    expect(s.counts.skipped).toBe(1);
    expect(s.skipRate).toBeCloseTo(1 / 9, 6);
  });

  it('is null, not zero, when nothing has elapsed', () => {
    expect(summarise([occ({ status: 'pending' })], { today: TODAY, settings: S }).adherence).toBeNull();
    expect(summarise([], { today: TODAY, settings: S }).adherence).toBeNull();
  });

  it('is zero when everything was missed', () => {
    const s = summarise([occ({ status: 'missed' })], { today: TODAY, settings: S });
    expect(s.adherence).toBe(0);
  });
});

describe('lateness', () => {
  const late = summarise(
    [
      occ({ status: 'done', dueTime: '09:00', completedAt: '2026-09-30T11:00:00.000Z' }),
      occ({ status: 'done', dueTime: '09:00', completedAt: '2026-09-30T07:00:00.000Z' }),
    ],
    { today: TODAY, settings: S },
  );

  it('derives lateness from completedAt without storing it', () => {
    expect(late.late).toBe(1);
    expect(late.lateRate).toBe(0.5);
  });

  it('ignores occurrences with no due time', () => {
    const s = summarise([occ({ status: 'done', completedAt: '2026-09-30T23:00:00.000Z' })], {
      today: TODAY,
      settings: S,
    });
    expect(s.late).toBe(0);
  });
});

describe('being behind', () => {
  it('counts recent misses over trailing windows', () => {
    const s = summarise(
      [
        occ({ status: 'missed', scheduledDate: '2026-09-29' }),
        occ({ status: 'missed', scheduledDate: '2026-09-20' }),
        occ({ status: 'missed', scheduledDate: '2026-08-01' }),
      ],
      { today: TODAY, settings: S },
    );
    expect(s.behind.last7).toBe(1);
    expect(s.behind.last30).toBe(2);
  });
});

describe('streaks (opt-in per rule)', () => {
  it('counts consecutive completions', () => {
    const s = computeStreak(
      [
        occ({ status: 'done', scheduledDate: '2026-09-28' }),
        occ({ status: 'done', scheduledDate: '2026-09-29' }),
        occ({ status: 'done', scheduledDate: '2026-09-30' }),
      ],
      { today: TODAY },
    );
    expect(s.current).toBe(3);
    expect(s.best).toBe(3);
  });

  it('breaks on a miss', () => {
    const s = computeStreak(
      [
        occ({ status: 'done', scheduledDate: '2026-09-27' }),
        occ({ status: 'missed', scheduledDate: '2026-09-28' }),
        occ({ status: 'done', scheduledDate: '2026-09-29' }),
      ],
      { today: TODAY },
    );
    expect(s.current).toBe(1);
    expect(s.best).toBe(1);
  });

  it('treats a skipped occurrence as neutral, not as a break', () => {
    // A holiday should not destroy a streak, and should not extend one either.
    const s = computeStreak(
      [
        occ({ status: 'done', scheduledDate: '2026-09-27' }),
        occ({ status: 'skipped', scheduledDate: '2026-09-28' }),
        occ({ status: 'done', scheduledDate: '2026-09-29' }),
      ],
      { today: TODAY },
    );
    expect(s.current).toBe(2);
  });

  it('remembers the best run even after it was broken', () => {
    const s = computeStreak(
      [
        occ({ status: 'done', scheduledDate: '2026-09-21' }),
        occ({ status: 'done', scheduledDate: '2026-09-22' }),
        occ({ status: 'done', scheduledDate: '2026-09-23' }),
        occ({ status: 'done', scheduledDate: '2026-09-24' }),
        occ({ status: 'missed', scheduledDate: '2026-09-25' }),
        occ({ status: 'done', scheduledDate: '2026-09-26' }),
      ],
      { today: TODAY },
    );
    expect(s.current).toBe(1);
    expect(s.best).toBe(4);
    expect(s.longestRunStart).toBe('2026-09-21');
  });

  it('ignores pending rows', () => {
    const s = computeStreak(
      [occ({ status: 'done', scheduledDate: '2026-09-29' }), occ({ status: 'pending', scheduledDate: TODAY })],
      { today: TODAY },
    );
    expect(s.current).toBe(1);
  });
});

describe('period report', () => {
  const rows: Occurrence[] = [
    ...Array.from({ length: 6 }, (_, i) =>
      occ({ status: 'done', scheduledDate: `2026-09-0${i + 1}` }),
    ),
    occ({ status: 'missed', scheduledDate: '2026-09-07' }),
    occ({ status: 'skipped', scheduledDate: '2026-09-08' }),
    occ({ status: 'done', scheduledDate: '2026-10-01' }),
  ];

  it('scopes everything to the requested period', () => {
    const report = buildReport({
      settings: S,
      today: TODAY,
      from: '2026-09-01',
      to: '2026-09-30',
      occurrences: rows,
      rules: [{ id: 'r1', title: 'Workout', trackStreak: true }],
    });
    expect(report.overall.counts.total).toBe(8);
    expect(report.overall.counts.done).toBe(6);
    expect(report.overall.adherence).toBeCloseTo(6 / 7, 6);
  });

  it('includes streaks only for rules that opt in', () => {
    const withStreak = buildReport({
      settings: S,
      today: TODAY,
      from: '2026-09-01',
      to: '2026-09-30',
      occurrences: rows,
      rules: [{ id: 'r1', title: 'Workout', trackStreak: true }],
    });
    const withoutStreak = buildReport({
      settings: S,
      today: TODAY,
      from: '2026-09-01',
      to: '2026-09-30',
      occurrences: rows,
      rules: [{ id: 'r1', title: 'Workout', trackStreak: false }],
    });
    expect(withStreak.perRule[0]?.streak).not.toBeNull();
    expect(withoutStreak.perRule[0]?.streak).toBeNull();
  });

  it('produces a per-month trend with gaps left null rather than zero', () => {
    const report = buildReport({
      settings: S,
      today: TODAY,
      from: '2026-07-01',
      to: '2026-10-31',
      occurrences: rows,
      rules: [{ id: 'r1', title: 'Workout', trackStreak: false }],
    });
    expect(report.trend.map((t) => t.bucket)).toEqual([
      '2026-07-01',
      '2026-08-01',
      '2026-09-01',
      '2026-10-01',
    ]);
    expect(report.trend[0]?.adherence).toBeNull();
    expect(report.trend[1]?.adherence).toBeNull();
    expect(report.trend[2]?.adherence).toBeCloseTo(6 / 7, 6);
  });

  it('omits rules with no activity in the period', () => {
    const report = buildReport({
      settings: S,
      today: TODAY,
      from: '2026-09-01',
      to: '2026-09-30',
      occurrences: rows,
      rules: [
        { id: 'r1', title: 'Workout', trackStreak: false },
        { id: 'r2', title: 'Nothing', trackStreak: true },
      ],
    });
    expect(report.perRule.map((p) => p.ruleId)).toEqual(['r1']);
  });
});
