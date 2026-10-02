import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  compareDates,
  daysBetween,
  eachDate,
  endOfMonth,
  formatDate,
  isValidDate,
  parseDate,
  startOfMonth,
  todayInTimeZone,
  zonedTimeToUtc,
} from '../src/index.js';

describe('calendar dates', () => {
  it('round-trips through the UTC carrier', () => {
    expect(formatDate(parseDate('2026-09-30'))).toBe('2026-09-30');
  });

  it('rejects impossible dates rather than rolling them over', () => {
    expect(() => parseDate('2026-02-31')).toThrow(RangeError);
    expect(() => parseDate('2026-13-01')).toThrow(RangeError);
    expect(isValidDate('2026-02-31')).toBe(false);
    expect(isValidDate('2026-02-28')).toBe(true);
  });

  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('is unaffected by daylight-saving transitions', () => {
    // Europe/Warsaw springs forward on 2026-03-29 (a 23-hour day) and falls
    // back on 2026-10-25 (a 25-hour day). Neither may perturb a date bucket.
    expect(addDays('2026-03-28', 1)).toBe('2026-03-29');
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
    expect(addDays('2026-10-24', 1)).toBe('2026-10-25');
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26');
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2);
  });

  it('clamps month arithmetic instead of overflowing', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
  });

  it('computes month boundaries including leap years', () => {
    expect(startOfMonth('2026-09-17')).toBe('2026-09-01');
    expect(endOfMonth('2026-09-17')).toBe('2026-09-30');
    expect(endOfMonth('2024-02-05')).toBe('2024-02-29');
    expect(endOfMonth('2026-02-05')).toBe('2026-02-28');
  });

  it('orders dates lexicographically', () => {
    expect(compareDates('2026-01-01', '2026-02-01')).toBe(-1);
    expect(compareDates('2026-02-01', '2026-01-01')).toBe(1);
    expect(compareDates('2026-02-01', '2026-02-01')).toBe(0);
  });

  it('enumerates inclusive ranges', () => {
    expect(eachDate('2026-09-28', '2026-09-30')).toEqual([
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
    ]);
    expect(eachDate('2026-09-30', '2026-09-30')).toEqual(['2026-09-30']);
  });
});

describe('timezone handling', () => {
  it('resolves today from the configured zone, not the host zone', () => {
    const instant = new Date('2026-09-30T23:30:00.000Z');
    expect(todayInTimeZone('UTC', instant)).toBe('2026-09-30');
    // Warsaw is UTC+2 in September, so it is already the next day there.
    expect(todayInTimeZone('Europe/Warsaw', instant)).toBe('2026-10-01');
    expect(todayInTimeZone('America/New_York', instant)).toBe('2026-09-30');
  });

  it('converts wall-clock time to a UTC instant', () => {
    expect(zonedTimeToUtc('2026-09-30', '04:00', 'UTC').toISOString()).toBe(
      '2026-09-30T04:00:00.000Z',
    );
    // Warsaw is UTC+2 on this date.
    expect(zonedTimeToUtc('2026-09-30', '04:00', 'Europe/Warsaw').toISOString()).toBe(
      '2026-09-30T02:00:00.000Z',
    );
  });

  it('handles the spring-forward gap', () => {
    // 02:30 on 2026-03-29 does not exist in Warsaw; the clock jumps 02:00 -> 03:00.
    // The conversion must still produce a usable instant rather than NaN.
    const result = zonedTimeToUtc('2026-03-29', '02:30', 'Europe/Warsaw');
    expect(Number.isNaN(result.getTime())).toBe(false);
  });

  it('handles the fall-back ambiguity', () => {
    // 02:30 on 2026-10-25 happens twice in Warsaw.
    const result = zonedTimeToUtc('2026-10-25', '02:30', 'Europe/Warsaw');
    expect(Number.isNaN(result.getTime())).toBe(false);
  });
});
