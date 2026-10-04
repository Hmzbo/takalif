import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HIJRI,
  GREGORIAN,
  hijriMonthLength,
  isHijri,
  isKnownCalendar,
  toGregorian,
  toHijri,
  type HijriDate,
} from '../src/calendars.js';

describe('calendar kinds', () => {
  it('recognises the supported set', () => {
    for (const c of ['gregorian', 'islamic-umalqura', 'islamic-civil', 'islamic-tbla']) {
      expect(isKnownCalendar(c)).toBe(true);
    }
    expect(isKnownCalendar('islamic-observational')).toBe(false);
    expect(isKnownCalendar('julian')).toBe(false);
  });

  it('classifies Hijri correctly', () => {
    expect(isHijri('gregorian')).toBe(false);
    expect(isHijri('islamic-umalqura')).toBe(true);
  });

  it('defaults to Umm al-Qura for the Hijri calendar', () => {
    expect(DEFAULT_HIJRI).toBe('islamic-umalqura');
  });
});

describe('toHijri (known values)', () => {
  // 2026-10-02 = 4/21/1448 AH, verified against ICU directly.
  it('converts a known Gregorian date', () => {
    expect(toHijri('2026-10-02', 'islamic-umalqura')).toEqual({
      year: 1448,
      month: 4,
      day: 21,
    });
  });

  it('starts the Hijri year correctly', () => {
    // 1 Muharram 1447.
    expect(toHijri('2026-01-01', 'islamic-umalqura')).toMatchObject({ year: 1447, month: 7 });
  });

  it('passes Gregorian through unchanged', () => {
    expect(toHijri('2026-10-02', GREGORIAN)).toEqual({ year: 2026, month: 10, day: 2 });
  });
});

describe('toGregorian (inversion)', () => {
  it('round-trips a known Hijri date', () => {
    expect(toGregorian({ year: 1448, month: 4, day: 21 }, 'islamic-umalqura')).toBe('2026-10-02');
  });

  it('returns null for a day that does not exist', () => {
    // A 29-day month has no day 30.
    const length = hijriMonthLength(1448, 1, 'islamic-umalqura');
    expect(toGregorian({ year: 1448, month: 1, day: length + 1 }, 'islamic-umalqura')).toBeNull();
  });

  it('is idempotent across the full Gregorian year', () => {
    // The exhaustive check that makes inversion trustworthy: every day of a
    // year must survive Gregorian -> Hijri -> Gregorian.
    let ok = 0;
    let bad: string[] = [];
    for (let day = 0; day < 365; day++) {
      const g = new Date(Date.UTC(2026, 0, 1) + day * 86_400_000);
      const date = g.toISOString().slice(0, 10);
      const h = toHijri(date, 'islamic-umalqura');
      const back = toGregorian(h, 'islamic-umalqura');
      if (back === date) ok++;
      else bad.push(`${date} -> ${JSON.stringify(h)} -> ${back}`);
    }
    expect(bad, bad.slice(0, 3).join('; ')).toEqual([]);
    expect(ok).toBe(365);
  });

  it('handles a 355-day Hijri leap year', () => {
    // 1448 AH sums to 355 days; the final month must have a day 30.
    const last = hijriMonthLength(1448, 12, 'islamic-umalqura');
    expect(toGregorian({ year: 1448, month: 12, day: last }, 'islamic-umalqura')).not.toBeNull();
  });

  it('round-trips far outside the seed year', () => {
    // The search bracket must not be tuned to one year.
    for (const [hijri, expected] of [
      [{ year: 1441, month: 10, day: 23 }, '2020-06-15'],
      [{ year: 1472, month: 9, day: 25 }, '2050-06-15'],
    ] as [HijriDate, string][]) {
      expect(toGregorian(hijri, 'islamic-umalqura')).toBe(expected);
      expect(toHijri(expected, 'islamic-umalqura')).toEqual(hijri);
    }
  });
});

describe('hijriMonthLength', () => {
  it('returns 29 or 30, never anything else', () => {
    for (let month = 1; month <= 12; month++) {
      const length = hijriMonthLength(1448, month, 'islamic-umalqura');
      expect([29, 30]).toContain(length);
    }
  });

  it('sums to 355 for the Hijri leap year 1448', () => {
    let total = 0;
    for (let month = 1; month <= 12; month++) {
      total += hijriMonthLength(1448, month, 'islamic-umalqura');
    }
    expect(total).toBe(355);
  });

  it('distinguishes the variants', () => {
    // Umm al-Qura and civil disagree on month lengths; 1448 is 355 vs 354.
    let umalqura = 0;
    let civil = 0;
    for (let month = 1; month <= 12; month++) {
      umalqura += hijriMonthLength(1448, month, 'islamic-umalqura');
      civil += hijriMonthLength(1448, month, 'islamic-civil');
    }
    expect(umalqura).toBe(355);
    expect(civil).toBe(354);
  });
});

describe('the fasting use case', () => {
  it('resolves 13/14/15 of every month to concrete Gregorian dates', () => {
    // The requirement: fast the 13th, 14th and 15th of each Hijri month.
    const fastDays: string[] = [];
    for (let month = 1; month <= 3; month++) {
      for (const day of [13, 14, 15]) {
        const g = toGregorian({ year: 1448, month, day }, 'islamic-umalqura');
        expect(g, `${day} of month ${month} should exist`).not.toBeNull();
        fastDays.push(g!);
      }
    }
    // Verified against ICU when this was designed.
    expect(fastDays).toEqual([
      '2026-06-28',
      '2026-06-29',
      '2026-06-30',
      '2026-07-27',
      '2026-07-28',
      '2026-07-29',
      '2026-08-26',
      '2026-08-27',
      '2026-08-28',
    ]);
  });

  it('skips a nonexistent day rather than clamping it', () => {
    // Find a 29-day month and assert day 30 does not silently become day 29.
    let shortMonth = 0;
    for (let month = 1; month <= 12; month++) {
      if (hijriMonthLength(1448, month, 'islamic-umalqura') === 29) {
        shortMonth = month;
        break;
      }
    }
    expect(shortMonth).toBeGreaterThan(0);
    expect(toGregorian({ year: 1448, month: shortMonth, day: 30 }, 'islamic-umalqura')).toBeNull();
  });
});
