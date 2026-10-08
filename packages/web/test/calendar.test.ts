import { describe, expect, it } from 'vitest';
import { monthFirst, monthGrid, shiftMonth, weekDays, weekStart } from '../src/calendar.js';

describe('weekStart', () => {
  it('returns the Monday of the containing week', () => {
    expect(weekStart('2026-10-08')).toBe('2026-10-05'); // Thursday
    expect(weekStart('2026-10-11')).toBe('2026-10-05'); // Sunday
    expect(weekStart('2026-10-05')).toBe('2026-10-05'); // Monday itself
  });

  it('crosses month boundaries', () => {
    expect(weekStart('2026-11-01')).toBe('2026-10-26'); // Sunday
  });

  it('rejects garbage', () => {
    expect(() => weekStart('not-a-date')).toThrow(RangeError);
  });
});

describe('weekDays', () => {
  it('returns seven consecutive dates from Monday to Sunday', () => {
    expect(weekDays('2026-10-05')).toEqual([
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
    ]);
  });
});

describe('monthGrid', () => {
  it('covers October 2026 with full weeks', () => {
    // Oct 1 is Thursday, Oct 31 Saturday.
    const grid = monthGrid(2026, 10);
    expect(grid).toHaveLength(35);
    expect(grid[0]).toBe('2026-09-28');
    expect(grid[grid.length - 1]).toBe('2026-11-01');
    expect(grid).toContain('2026-10-01');
    expect(grid).toContain('2026-10-31');
  });

  it('starts cleanly when the month opens on Monday', () => {
    // June 1 2026 is Monday, June 30 Tuesday.
    const grid = monthGrid(2026, 6);
    expect(grid[0]).toBe('2026-06-01');
    expect(grid[grid.length - 1]).toBe('2026-07-05');
  });

  it('includes leap day', () => {
    expect(monthGrid(2024, 2)).toContain('2024-02-29');
  });

  it('crosses the year boundary', () => {
    // Dec 1 2026 is Tuesday, Dec 31 Thursday.
    const grid = monthGrid(2026, 12);
    expect(grid[0]).toBe('2026-11-30');
    expect(grid[grid.length - 1]).toBe('2027-01-03');
    expect(grid).toContain('2026-12-31');
    expect(grid).toContain('2027-01-01');
  });

  it('rejects an invalid month', () => {
    expect(() => monthGrid(2026, 13)).toThrow(RangeError);
  });
});

describe('month stepping', () => {
  it('shifts by whole months with clamping', () => {
    expect(shiftMonth('2026-10-15', 1)).toBe('2026-11-15');
    expect(shiftMonth('2026-10-15', -1)).toBe('2026-09-15');
    expect(shiftMonth('2026-01-31', 1)).toBe('2026-02-28');
    expect(shiftMonth('2026-01-15', -1)).toBe('2025-12-15');
    expect(monthFirst('2026-10-15')).toBe('2026-10-01');
  });
});
