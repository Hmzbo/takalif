import { describe, expect, it } from 'vitest';
import {
  calendarLabel,
  formatAdherence,
  formatCalendarDate,
  formatCounts,
  formatDayLabel,
  shiftDate,
  todayUTC,
} from '../src/format';

describe('formatAdherence', () => {
  it('rounds to whole percent', () => {
    expect(formatAdherence(2 / 3)).toBe('67%');
    expect(formatAdherence(1)).toBe('100%');
    expect(formatAdherence(0)).toBe('0%');
  });

  // The domain reports null when nothing has elapsed; the UI must render an
  // em dash rather than a misleading 0%. See core stats.ts.
  it('renders null as an em dash, never 0%', () => {
    expect(formatAdherence(null)).toBe('—');
  });
});

describe('formatCounts', () => {
  it('shows done over done-plus-missed', () => {
    expect(formatCounts(20, 10, 0)).toBe('20 / 30');
  });

  it('keeps the skipped count beside the result so the denominator is never hidden', () => {
    expect(formatCounts(20, 10, 2)).toBe('20 / 30 · 2 skipped');
  });
});

describe('formatDayLabel', () => {
  it('renders a civil date without timezone dependence', () => {
    expect(formatDayLabel('2026-10-04')).toBe('Sun 4 Oct');
    expect(formatDayLabel('2026-01-01')).toBe('Thu 1 Jan');
  });
});

describe('shiftDate', () => {
  it('moves across month and year boundaries', () => {
    expect(shiftDate('2026-10-04', -1)).toBe('2026-10-03');
    expect(shiftDate('2026-10-04', 1)).toBe('2026-10-05');
    expect(shiftDate('2026-01-01', -1)).toBe('2025-12-31');
  });
});

describe('todayUTC', () => {
  it('returns a civil date string', () => {
    expect(todayUTC()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('formatCalendarDate', () => {
  it('renders Gregorian as a plain day label', () => {
    expect(
      formatCalendarDate('2026-10-04', { year: 1448, month: 4, day: 22 }, 'gregorian'),
    ).toBe('Sun 4 Oct');
  });

  it("renders Hijri with a transliterated month name", () => {
    expect(
      formatCalendarDate('2026-10-03', { year: 1448, month: 4, day: 21 }, 'islamic-umalqura'),
    ).toBe("21 Rabi' II 1448");
    expect(
      formatCalendarDate('2026-09-01', { year: 1448, month: 9, day: 1 }, 'islamic-civil'),
    ).toBe('1 Ramadan 1448');
  });
});

describe('calendarLabel', () => {
  it('labels the known calendars and passes anything else through', () => {
    expect(calendarLabel('gregorian')).toBe('Gregorian');
    expect(calendarLabel('islamic-umalqura')).toBe('Hijri · Umm al-Qura');
    expect(calendarLabel('nope')).toBe('nope');
  });
});
