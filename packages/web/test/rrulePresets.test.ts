import { describe, expect, it } from 'vitest';
import {
  buildRRule,
  describeRRule,
  parseMonthDays,
  PRESETS,
  WEEKDAYS,
} from '../src/rrulePresets';

describe('buildRRule', () => {
  it('builds a daily rule', () => {
    expect(buildRRule({ kind: 'daily' })).toBe('FREQ=DAILY');
    expect(buildRRule({ kind: 'daily', interval: 3 })).toBe('FREQ=DAILY;INTERVAL=3');
  });

  it('builds a weekdays rule', () => {
    expect(buildRRule({ kind: 'weekdays' })).toBe('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
  });

  it('builds a weekly rule on chosen days, sorted Monday-first', () => {
    expect(buildRRule({ kind: 'weekly', days: ['FR', 'MO'] })).toBe('FREQ=WEEKLY;BYDAY=MO,FR');
    expect(buildRRule({ kind: 'weekly', days: ['TU'], interval: 2 })).toBe(
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU',
    );
  });

  it('defaults an empty weekly selection to Monday rather than emitting invalid output', () => {
    expect(buildRRule({ kind: 'weekly', days: [] })).toBe('FREQ=WEEKLY;BYDAY=MO');
  });

  it('builds a monthly rule, clamped to 1–31 and deduplicated', () => {
    expect(buildRRule({ kind: 'monthly', monthDays: [15, 1, 1, 99] })).toBe(
      'FREQ=MONTHLY;BYMONTHDAY=1,15,31',
    );
    expect(buildRRule({ kind: 'monthly' })).toBe('FREQ=MONTHLY;BYMONTHDAY=1');
  });

  it('floors the interval at 1', () => {
    expect(buildRRule({ kind: 'daily', interval: 0 })).toBe('FREQ=DAILY');
    expect(buildRRule({ kind: 'daily', interval: -4 })).toBe('FREQ=DAILY');
  });

  it('passes custom RRULE through trimmed', () => {
    expect(buildRRule({ kind: 'custom', custom: '  FREQ=YEARLY  ' })).toBe('FREQ=YEARLY');
  });
});

describe('describeRRule', () => {
  it('describes the common shapes', () => {
    expect(describeRRule('FREQ=DAILY')).toBe('Every day');
    expect(describeRRule('FREQ=DAILY;INTERVAL=3')).toBe('Every 3 days');
    expect(describeRRule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')).toBe('Weekdays');
    expect(describeRRule('FREQ=WEEKLY;BYDAY=MO,FR')).toBe('Every week · Mon, Fri');
    expect(describeRRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU')).toBe('Every 2 weeks · Tue');
    expect(describeRRule('FREQ=MONTHLY;BYMONTHDAY=1')).toBe('Every month · 1st');
    expect(describeRRule('FREQ=MONTHLY;BYMONTHDAY=13,14,15')).toBe('Every month · 13th, 14th, 15th');
  });

  it('falls back to the raw value for anything unrecognised', () => {
    expect(describeRRule('FREQ=YEARLY;BYMONTH=1')).toBe('FREQ=YEARLY;BYMONTH=1');
  });
});

describe('parseMonthDays', () => {
  it('parses comma-separated days, ignoring junk', () => {
    expect(parseMonthDays('1, 15')).toEqual([1, 15]);
    expect(parseMonthDays('31,0,32,abc,,7')).toEqual([7, 31]);
    expect(parseMonthDays('')).toEqual([]);
  });
});

describe('preset metadata', () => {
  it('covers every preset kind exactly once', () => {
    const kinds = PRESETS.map((p) => p.kind).sort();
    expect(kinds).toEqual(['custom', 'daily', 'monthly', 'weekdays', 'weekly']);
  });

  it('lists the week Monday-first', () => {
    expect(WEEKDAYS.map((w) => w.key)).toEqual(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);
  });
});
