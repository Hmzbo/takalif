#!/usr/bin/env node
/**
 * Generate a demo ledger: a backup-format JSON document filled with
 * plausible history — months of done/missed across seven rules (daily,
 * weekdays, weekly, monthly, one Hijri, one archived), a vacation skip
 * period, streaks and occasional notes — so every screen and statistic has
 * something to show.
 *
 * The file is a standard backup document, and import goes through the
 * server's own validated restore path: no SQL here, no schema to keep in
 * sync. Importing REPLACES ALL DATA on the target server — for a scratch
 * look, run a second container on another port and import there.
 *
 * Output: data/demo-ledger.json (data/ is gitignored).
 *
 * Deterministic for a given run date: the PRNG is seeded, so regenerating
 * on the same day yields the same file.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const out = join(root, 'data', 'demo-ledger.json');

const now = new Date();

/** The host's zone, so "today" is today for whoever runs this. Server-side
 *  setting in the real app; the seed just picks something sane. */
const zone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();

/** Today as a civil date in the host zone (en-CA formats as YYYY-MM-DD). */
const TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: zone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(now);

const addDays = (date, days) => {
  const dt = new Date(`${date}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
};

const ts = (date) => `${date}T12:00:00.000Z`;

/** Deterministic PRNG so the demo is reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(Number(new Date(`${TODAY}T00:00:00Z`) % 0x7fffffff) + 1);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const RULE_DEFS = [
  {
    title: 'Morning workout',
    rrule: 'FREQ=DAILY',
    category: 'health',
    dueTime: '07:00',
    reminderTime: '06:30',
    trackStreak: true,
    createdDaysAgo: 90,
    missRate: 0.1,
  },
  {
    title: 'Read 30 minutes',
    rrule: 'FREQ=DAILY',
    category: 'learning',
    dueTime: null,
    reminderTime: null,
    trackStreak: true,
    createdDaysAgo: 90,
    missRate: 0.22,
  },
  {
    title: 'Team standup',
    rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    category: 'work',
    dueTime: '09:30',
    reminderTime: null,
    trackStreak: false,
    createdDaysAgo: 90,
    missRate: 0.08,
  },
  {
    title: 'Weekly review',
    rrule: 'FREQ=WEEKLY;BYDAY=SU',
    category: 'reflection',
    dueTime: '20:00',
    reminderTime: '19:00',
    trackStreak: false,
    createdDaysAgo: 60,
    missRate: 0.15,
  },
  {
    title: 'Pay rent',
    rrule: 'FREQ=MONTHLY;BYMONTHDAY=1',
    category: 'finance',
    dueTime: null,
    reminderTime: null,
    trackStreak: false,
    createdDaysAgo: 90,
    missRate: 0,
  },
  {
    // Exercises the multi-calendar feature end to end.
    title: 'Fasting 13-14-15',
    rrule: 'FREQ=MONTHLY;BYMONTHDAY=13,14,15;CALENDAR=ISLAMIC_UMALQURA',
    category: 'spiritual',
    calendar: 'islamic-umalqura',
    dueTime: null,
    reminderTime: null,
    trackStreak: false,
    createdDaysAgo: 90,
    missRate: 0.12,
    hijri: true,
  },
  {
    // Archived: history queryable, no generation. Shows the preserved section.
    title: 'Morning pages (old plan)',
    rrule: 'FREQ=DAILY',
    category: 'reflection',
    dueTime: null,
    reminderTime: null,
    trackStreak: false,
    createdDaysAgo: 90,
    missRate: 0.3,
    active: false,
    lastDayOffset: -20,
  },
];

/** A week away mid-history: those days become `skipped`, leaving the denominator. */
const vacationStart = addDays(TODAY, -50);
const vacationEnd = addDays(TODAY, -44);

const NOTES = [
  'Felt strong today.',
  'Tired, but showed up.',
  'Short session — better than nothing.',
  'Did it at the park instead.',
  'Late start, still counted.',
];

/**
 * Hijri day-of-month for a civil date, forward-only via Intl — the exact
 * direction seeding needs. Full ICU ships with Node 22 (verified in the
 * calendar docs).
 */
const hijriDay = (() => {
  const fmt = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', {
    day: 'numeric',
    timeZone: 'UTC',
  });
  return (date) => {
    try {
      return Number(fmt.format(new Date(`${date}T00:00:00Z`)).replace(/[^0-9]/g, ''));
    } catch {
      return 0;
    }
  };
})();

const DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** Mirror of what expandRRule would say for the simple shapes we seed. */
function isScheduled(def, date) {
  if (def.hijri) return [13, 14, 15].includes(hijriDay(date));
  const dt = new Date(`${date}T00:00:00Z`);
  const freq = /^FREQ=(DAILY|WEEKLY|MONTHLY)/.exec(def.rrule)?.[1];
  if (freq === 'DAILY') return true;
  if (freq === 'WEEKLY') {
    const byday = [...def.rrule.matchAll(/BYDAY=([A-Z,]+)/g)].pop()?.[1] ?? '';
    return byday.split(',').some((d) => DOW[d] === dt.getUTCDay());
  }
  if (freq === 'MONTHLY') {
    const md = [...def.rrule.matchAll(/BYMONTHDAY=(\d+)/g)].pop()?.[1];
    return md !== undefined && Number(md) === dt.getUTCDate();
  }
  return false;
}

const rules = [];
const ruleVersions = [];
const occurrences = [];

for (const def of RULE_DEFS) {
  const id = randomUUID();
  const createdDate = addDays(TODAY, -def.createdDaysAgo);
  const active = def.active !== false;

  rules.push({
    id,
    title: def.title,
    description: null,
    rrule: def.rrule,
    dtstartDate: createdDate,
    dueTime: def.dueTime,
    reminderTime: def.reminderTime,
    calendar: def.calendar ?? 'gregorian',
    createdDate,
    trackStreak: Boolean(def.trackStreak),
    category: def.category,
    active,
    createdAt: ts(createdDate),
    updatedAt: ts(createdDate),
  });
  ruleVersions.push({
    id: randomUUID(),
    ruleId: id,
    version: 1,
    rrule: def.rrule,
    dtstartDate: createdDate,
    effectiveFrom: createdDate,
    createdAt: ts(createdDate),
  });

  const last = def.lastDayOffset !== undefined ? addDays(TODAY, def.lastDayOffset) : TODAY;
  for (let d = createdDate; d <= last; d = addDays(d, 1)) {
    if (!isScheduled(def, d)) continue;

    let status;
    if (d === TODAY && active) {
      // Today is still open: a few already done, the rest wait for the user.
      status = rand() < 0.4 ? 'done' : 'pending';
    } else if (active && d >= vacationStart && d <= vacationEnd) {
      status = 'skipped';
    } else {
      status = rand() < def.missRate ? 'missed' : 'done';
    }

    // Only `done` carries a completion instant; today's completions are in
    // the past few hours so nothing looks completed in the future.
    let completedAt = null;
    if (status === 'done') {
      completedAt =
        d === TODAY
          ? new Date(now.getTime() - (1 + rand() * 4) * 3_600_000).toISOString()
          : `${d}T${String(6 + Math.floor(rand() * 14)).padStart(2, '0')}:${String(
              Math.floor(rand() * 60),
            ).padStart(2, '0')}:00.000Z`;
    }

    occurrences.push({
      id: randomUUID(),
      ruleId: id,
      ruleVersion: 1,
      scheduledDate: d,
      dueTime: def.dueTime,
      status,
      completedAt,
      note:
        status === 'done' && rand() < 0.08 ? pick(NOTES) : null,
      createdAt: ts(d),
      updatedAt: completedAt ?? ts(d),
    });
  }
}

const skipPeriods = [
  {
    id: randomUUID(),
    startDate: vacationStart,
    endDate: vacationEnd,
    reason: 'Family visit',
    createdAt: ts(vacationStart),
  },
];

const doc = {
  version: 1,
  exportedAt: now.toISOString(),
  settings: {
    timezone: zone,
    dayRollover: '04:00',
    lookbackDays: 30,
    lookaheadDays: 14,
    defaultCalendar: 'gregorian',
    email: null,
    ntfyTopic: null,
    ntfyServer: null,
  },
  rules,
  ruleVersions,
  occurrences,
  skipPeriods,
  exceptions: [],
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(doc, null, 2));

const count = (s) => occurrences.filter((o) => o.status === s).length;
console.log(`Wrote ${out}`);
console.log(
  `  ${rules.length} rules (${rules.filter((r) => r.active).length} active), ` +
    `${occurrences.length} occurrences: ` +
    `${count('done')} done, ${count('missed')} missed, ` +
    `${count('skipped')} skipped, ${count('pending')} pending`,
);
console.log(`  timezone ${zone}, today ${TODAY}`);
console.log('  Import via Settings → Data → Restore from backup. RESTORE REPLACES ALL DATA.');
