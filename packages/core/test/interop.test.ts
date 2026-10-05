import { describe, expect, it } from 'vitest';
import {
  BACKUP_VERSION,
  buildBackup,
  escapeVText,
  foldVLine,
  ledgerToCsv,
  LEDGER_CSV_HEADER,
  parseBackupDocument,
  rulesToVCalendar,
  toLedgerCsvRows,
  type BackupDocument,
} from '../src/interop.js';
import type { Occurrence, Rule } from '../src/types.js';

const SETTINGS = {
  timezone: 'Europe/Warsaw',
  dayRollover: '04:00',
  lookbackDays: 30,
  lookaheadDays: 14,
  defaultCalendar: 'gregorian' as const,
  email: null,
  ntfyTopic: null,
  ntfyServer: null,
};

const RULE: Rule = {
  id: 'rule-1',
  title: 'Workout',
  description: null,
  rrule: 'FREQ=DAILY',
  dtstartDate: '2026-01-01',
  dueTime: null,
  reminderTime: null,
  calendar: 'gregorian',
  createdDate: '2026-01-01',
  trackStreak: false,
  category: null,
  active: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const BACKUP: BackupDocument = {
  version: BACKUP_VERSION,
  exportedAt: '2026-10-05T00:00:00.000Z',
  settings: SETTINGS,
  rules: [RULE],
  ruleVersions: [
    {
      id: 'v-1',
      ruleId: 'rule-1',
      version: 1,
      rrule: 'FREQ=DAILY',
      dtstartDate: '2026-01-01',
      effectiveFrom: '2026-01-01',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  occurrences: [
    {
      id: 'occ-1',
      ruleId: 'rule-1',
      ruleVersion: 1,
      scheduledDate: '2026-10-01',
      dueTime: null,
      status: 'done',
      completedAt: '2026-10-01T18:00:00.000Z',
      note: null,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T18:00:00.000Z',
    },
  ],
  skipPeriods: [],
  exceptions: [],
};

describe('backup envelope', () => {
  it('builds a versioned envelope around the current state', () => {
    const doc = buildBackup(
      {
        settings: SETTINGS,
        rules: [RULE],
        ruleVersions: [],
        occurrences: [],
        skipPeriods: [],
        exceptions: [],
      },
      new Date('2026-10-05T12:00:00.000Z'),
    );
    expect(doc.version).toBe(1);
    expect(doc.exportedAt).toBe('2026-10-05T12:00:00.000Z');
    expect(doc.rules).toHaveLength(1);
  });

  it('round-trips a complete document', () => {
    expect(parseBackupDocument(JSON.parse(JSON.stringify(BACKUP)))).toEqual(BACKUP);
  });

  it('rejects a version it does not understand rather than half-restoring', () => {
    expect(() => parseBackupDocument({ ...BACKUP, version: 99 })).toThrow(/version/);
  });

  it('rejects an occurrence that references an unknown rule', () => {
    const bad = {
      ...BACKUP,
      occurrences: [{ ...BACKUP.occurrences[0]!, ruleId: 'ghost' }],
    };
    expect(() => parseBackupDocument(bad)).toThrow(/unknown rule/);
  });

  it('rejects a duplicate (ruleId, scheduledDate) pair', () => {
    const dup: Occurrence = { ...BACKUP.occurrences[0]!, id: 'occ-2' };
    expect(() => parseBackupDocument({ ...BACKUP, occurrences: [BACKUP.occurrences[0], dup] })).toThrow(
      /duplicate/,
    );
  });

  it('rejects an invalid RRULE instead of importing a rule that generates nothing', () => {
    const bad = { ...BACKUP, rules: [{ ...RULE, rrule: 'FREQ=NONSENSE' }] };
    expect(() => parseBackupDocument(bad)).toThrow(/RRULE/);
  });

  it('rejects a skip period whose end precedes its start', () => {
    const bad = {
      ...BACKUP,
      skipPeriods: [{ id: 's1', startDate: '2026-08-21', endDate: '2026-08-01', reason: null }],
    };
    expect(() => parseBackupDocument(bad)).toThrow(/endDate/);
  });

  it('rejects a duplicate (ruleId, version) pair', () => {
    const dup = { ...BACKUP.ruleVersions[0]!, id: 'v-2' };
    expect(() =>
      parseBackupDocument({ ...BACKUP, ruleVersions: [BACKUP.ruleVersions[0], dup] }),
    ).toThrow(/duplicate/);
  });

  it('rejects an occurrence dated before the rule was created', () => {
    const early: Occurrence = { ...BACKUP.occurrences[0]!, id: 'occ-2', scheduledDate: '2025-12-31' };
    expect(() =>
      parseBackupDocument({ ...BACKUP, occurrences: [BACKUP.occurrences[0], early] }),
    ).toThrow(/createdDate/);
  });

  it('rejects an occurrence pointing at an unknown rule version', () => {
    const bad = { ...BACKUP, occurrences: [{ ...BACKUP.occurrences[0]!, ruleVersion: 7 }] };
    expect(() => parseBackupDocument(bad)).toThrow(/version/);
  });

  it('rejects settings the interactive route would reject', () => {
    const bad = { ...BACKUP, settings: { ...SETTINGS, ntfyTopic: 'has spaces!' } };
    expect(() => parseBackupDocument(bad)).toThrow(/ntfyTopic/);
  });

  it('rejects an id containing a line break', () => {
    const bad = { ...BACKUP, rules: [{ ...RULE, id: 'evil\nUID:inject' }] };
    expect(() => parseBackupDocument(bad)).toThrow(/line break/);
  });
});

describe('CSV ledger', () => {
  it('emits a header plus one row per occurrence', () => {
    const rows = toLedgerCsvRows(BACKUP.occurrences, BACKUP.rules);
    const csv = ledgerToCsv(rows);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe(LEDGER_CSV_HEADER);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('rule-1,Workout,2026-10-01,done');
  });

  it('quotes fields containing commas, quotes and newlines', () => {
    const csv = ledgerToCsv([
      {
        ruleId: 'r1',
        ruleTitle: 'Gym, "legs"\nand core',
        scheduledDate: '2026-10-01',
        status: 'done',
        dueTime: null,
        completedAt: null,
        ruleVersion: 1,
        calendar: 'gregorian',
        category: null,
      },
    ]);
    expect(csv).toContain('"Gym, ""legs""\nand core"');
  });

  it('labels rows whose rule is gone as archived rather than dropping them', () => {
    const rows = toLedgerCsvRows(BACKUP.occurrences, []);
    expect(rows[0]!.ruleTitle).toBe('(archived)');
    expect(ledgerToCsv(rows)).toContain('(archived)');
  });

  it('neutralises spreadsheet formulas in user-controlled fields', () => {
    const csv = ledgerToCsv([
      {
        ruleId: 'r1',
        ruleTitle: '=SUM(A1:A10)',
        scheduledDate: '2026-10-01',
        status: 'done',
        dueTime: null,
        completedAt: null,
        ruleVersion: 1,
        calendar: 'gregorian',
        category: '@mention',
      },
    ]);
    expect(csv).toContain("'=SUM(A1:A10)");
    expect(csv).toContain("'@mention");
  });
});

describe('VTODO export', () => {
  it('exports one VTODO per rule with a stable UID and the RRULE', () => {
    const ics = rulesToVCalendar([RULE], new Date('2026-10-05T12:00:00.000Z'));
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('BEGIN:VTODO');
    expect(ics).toContain('UID:rule-1@takalif');
    expect(ics).toContain('RRULE:FREQ=DAILY');
    expect(ics).toContain('DTSTART;VALUE=DATE:20260101');
    expect(ics).toContain('END:VCALENDAR');
  });

  it('escapes TEXT fields and marks archived rules cancelled', () => {
    const archived: Rule = { ...RULE, id: 'r2', title: 'Rent; paid, done', active: false };
    const ics = rulesToVCalendar([archived]);
    expect(ics).toContain('SUMMARY:Rent\\; paid\\, done');
    expect(ics).toContain('STATUS:CANCELLED');
  });

  it('keeps the Takalif calendar out of the RRULE and in an X- property', () => {
    const hijri: Rule = {
      ...RULE,
      id: 'fast',
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=13,14,15',
      calendar: 'islamic-umalqura',
    };
    const ics = rulesToVCalendar([hijri]);
    expect(ics).toContain('X-TAKALIF-CALENDAR:islamic-umalqura');
    expect(ics).not.toContain('CALENDAR=');
  });

  it('lifts embedded EXDATE parts into real EXDATE properties', () => {
    const withEx: Rule = { ...RULE, rrule: 'FREQ=DAILY;EXDATE:20261002' };
    const ics = rulesToVCalendar([withEx]);
    expect(ics).toContain('EXDATE;VALUE=DATE:20261002');
    expect(ics).not.toMatch(/RRULE:.*EXDATE/);
  });

  it('escapeVText handles the four special sequences', () => {
    expect(escapeVText('a\\b,c;d\ne')).toBe('a\\\\b\\,c\\;d\\ne');
  });

  it('foldVLine keeps every emitted line within 75 characters', () => {
    const ics = rulesToVCalendar([{ ...RULE, title: 'x'.repeat(200) }]);
    for (const line of ics.split('\r\n')) {
      if (line.length === 0) continue;
      expect(line.length).toBeLessThanOrEqual(75);
    }
    expect(foldVLine('y'.repeat(200)).split('\r\n')[1]![0]).toBe(' ');
  });

  it('foldVLine counts octets, not characters, and never splits a code point', () => {
    const folded = foldVLine('é'.repeat(50));
    const encoder = new TextEncoder();
    for (const line of folded.split('\r\n')) {
      expect(encoder.encode(line.replace(/^ /, '')).length).toBeLessThanOrEqual(75);
    }
    expect(folded).toContain('é');
  });
});
