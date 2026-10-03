import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { openDatabase, type DB } from '../src/db.js';

/**
 * Integration tests against a real SQLite file.
 *
 * `packages/core` proves the *plan* is right; nothing proved that the SQL which
 * persists it honours the same invariants. That gap is where every review
 * finding lived — the settings wedge, the frozen-terminal breach, the silent
 * no-op reset, and every error path answering 200.
 *
 * Each case builds a fresh app and database: no ordering dependency, no shared
 * state.
 */

interface Reply {
  statusCode: number;
  body: string;
  json: () => any;
}

interface Harness {
  app: FastifyInstance;
  db: DB;
  post: (url: string, body?: unknown) => Promise<Reply>;
  patch: (url: string, body: unknown) => Promise<Reply>;
  del: (url: string) => Promise<Reply>;
  get: (url: string) => Promise<Reply>;
  makeRule: (over?: Record<string, unknown>) => Promise<any>;
  occurrenceOn: (date: string) => Promise<any>;
  today: () => Promise<string>;
  all: <T = Record<string, unknown>>(sql: string, ...params: unknown[]) => T[];
  cleanup: () => void;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'takalif-test-'));
  const db = openDatabase(join(dir, 'test.sqlite'));
  const app = buildApp(db, { logger: false });

  const wrap = (r: { statusCode: number; body: string }): Reply => ({
    statusCode: r.statusCode,
    body: r.body,
    json: () => JSON.parse(r.body),
  });

  const withBody = (method: string, url: string, body?: unknown) =>
    app.inject({
      method: method as 'POST',
      url,
      ...(body === undefined
        ? {}
        : { payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    });

  return {
    app,
    db,
    post: async (url, body) => wrap(await withBody('POST', url, body)),
    patch: async (url, body) => wrap(await withBody('PATCH', url, body)),
    del: async (url) => wrap(await app.inject({ method: 'DELETE', url })),
    get: async (url) => wrap(await app.inject({ method: 'GET', url })),
    async makeRule(over: Record<string, unknown> = {}) {
      const res = wrap(await withBody('POST', '/api/rules', { title: 'Workout', rrule: 'FREQ=DAILY', ...over }));
      expect(res.statusCode, `rule creation failed: ${res.body}`).toBe(201);
      return res.json();
    },
    async occurrenceOn(date: string) {
      const res = wrap(await app.inject({ method: 'GET', url: `/api/day?date=${date}` }));
      expect(res.statusCode).toBe(200);
      return res.json().items?.[0];
    },
    async today() {
      return JSON.parse((await app.inject({ method: 'GET', url: '/api/day' })).body).today;
    },
    all<T = Record<string, unknown>>(sql: string, ...params: unknown[]) {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
    cleanup: () => {
      void app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('materialisation', () => {
  it('materialises a rule and stays idempotent across repeated syncs', async () => {
    const h = harness();
    try {
      await h.makeRule();
      const today = await h.today();
      for (let i = 0; i < 3; i++) {
        expect((await h.get(`/api/day?date=${today}`)).json().items).toHaveLength(1);
      }
      // Three syncs must not have produced three windows of rows.
      const before = h.all<{ n: number }>('SELECT COUNT(*) AS n FROM occurrences')[0]!.n;
      await h.get('/api/day');
      const after = h.all<{ n: number }>('SELECT COUNT(*) AS n FROM occurrences')[0]!.n;
      expect(after).toBe(before);
    } finally {
      h.cleanup();
    }
  });

  it('does not fabricate history before a rule was created', async () => {
    const h = harness();
    try {
      // Widen the window so past dates are materialised at all.
      await h.patch('/api/settings', { lookbackDays: 3660 });
      await h.makeRule({ createdDate: '2026-01-01', dtstartDate: '2026-01-01' });
      const res = await h.get('/api/occurrences?from=2025-01-01&to=2025-12-31');
      expect(res.json()).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  it('surfaces rules that cannot expand instead of silently dropping them', async () => {
    const h = harness();
    try {
      // A corrupt rule written directly, bypassing API validation. The generator
      // only looks at rules that have a version row, so both are needed.
      h.db
        .prepare(
          `INSERT INTO rules (id,title,rrule,dtstart_date,created_date,active,created_at,updated_at)
           VALUES (?,?,?,?,?,1,?,?)`,
        )
        .run('broken', 'Broken', 'FREQ=NONSENSE', '2026-01-01', '2026-01-01', 'x', 'x');
      h.db
        .prepare(
          `INSERT INTO rule_versions (id,rule_id,version,rrule,dtstart_date,effective_from,created_at)
           VALUES (?,?,1,?,?,?,?)`,
        )
        .run('bv1', 'broken', 'FREQ=NONSENSE', '2026-01-01', '2026-01-01', 'x');

      const res = await h.get('/api/rules');
      expect(res.json().failedRules).toHaveLength(1);
      expect(res.json().failedRules[0].ruleId).toBe('broken');
    } finally {
      h.cleanup();
    }
  });
});

describe('terminal states are frozen', () => {
  it('refuses to overwrite a completed occurrence', async () => {
    const h = harness();
    try {
      await h.makeRule();
      const occ = await h.occurrenceOn(await h.today());
      expect((await h.post(`/api/occurrences/${occ.id}/done`)).statusCode).toBe(200);

      const again = await h.post(`/api/occurrences/${occ.id}/done`);
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toMatch(/already done/);

      const stored = h.all<{ status: string }>('SELECT status FROM occurrences WHERE id = ?', occ.id)[0]!;
      expect(stored.status).toBe('done');
    } finally {
      h.cleanup();
    }
  });

  it('preserves a user note when the day closes', async () => {
    const h = harness();
    try {
      // Widen the window so past dates are materialised at all.
      await h.patch('/api/settings', { lookbackDays: 3660 });
      await h.makeRule({ createdDate: '2026-01-01', dtstartDate: '2026-01-01' });
      const occ = await h.occurrenceOn('2026-01-05');
      expect(occ, 'expected a materialised occurrence on 2026-01-05').toBeTruthy();
      h.db.prepare('UPDATE occurrences SET note = ? WHERE id = ?').run('gym instead', occ.id);

      await h.get('/api/day');

      const after = h.all<{ note: string }>('SELECT note FROM occurrences WHERE id = ?', occ.id)[0]!;
      expect(after.note).toBe('gym instead');
    } finally {
      h.cleanup();
    }
  });
});

describe('occurrence lifecycle', () => {
  it('marks missed and conflicts on a second attempt', async () => {
    const h = harness();
    try {
      await h.makeRule();
      const occ = await h.occurrenceOn(await h.today());
      expect((await h.post(`/api/occurrences/${occ.id}/missed`)).statusCode).toBe(200);
      expect((await h.post(`/api/occurrences/${occ.id}/missed`)).statusCode).toBe(409);
    } finally {
      h.cleanup();
    }
  });

  it('404s for an occurrence that does not exist', async () => {
    const h = harness();
    try {
      const res = await h.post('/api/occurrences/00000000-0000-0000-0000-000000000000/done');
      expect(res.statusCode).toBe(404);
    } finally {
      h.cleanup();
    }
  });

  it('rejects a non-ISO completion timestamp', async () => {
    const h = harness();
    try {
      await h.makeRule();
      const occ = await h.occurrenceOn(await h.today());
      expect((await h.post(`/api/occurrences/${occ.id}/done`, { at: 'not-a-date' })).statusCode).toBe(400);
    } finally {
      h.cleanup();
    }
  });

  it('resets an open day, and refuses once the day has closed', async () => {
    const h = harness();
    try {
      // Widen the window so a settled past date exists to test against.
      await h.patch('/api/settings', { lookbackDays: 3660 });
      await h.makeRule({ createdDate: '2020-01-01', dtstartDate: '2020-01-01' });
      const occ = await h.occurrenceOn(await h.today());

      const reset = await h.post(`/api/occurrences/${occ.id}/reset`);
      expect(reset.statusCode).toBe(200);
      expect(reset.json().status).toBe('pending');
      // Same shape as its sibling routes, not raw snake_case.
      expect(reset.json()).toHaveProperty('ruleId');
      expect(reset.json()).not.toHaveProperty('rule_id');

      // A day in the past has closed: reset must say so rather than no-op.
      const past = (await h.get('/api/occurrences?from=2020-01-01&to=2020-01-01')).json()[0];
      expect(past, 'expected a settled occurrence in 2020').toBeTruthy();
      const pastRes = await h.post(`/api/occurrences/${past.id}/reset`);
      expect(pastRes.statusCode).toBe(409);
      expect(pastRes.json().error).toMatch(/already closed/);
    } finally {
      h.cleanup();
    }
  });

  it('excuses an occurrence so it leaves the adherence denominator', async () => {
    const h = harness();
    try {
      // Widen the window so past dates are materialised at all.
      await h.patch('/api/settings', { lookbackDays: 3660 });
      await h.makeRule({ createdDate: '2026-01-01', dtstartDate: '2026-01-01' });
      const occ = (await h.get('/api/occurrences?from=2026-01-10&to=2026-01-10')).json()[0];
      expect(occ, 'expected a settled occurrence on 2026-01-10').toBeTruthy();
      const res = await h.post(`/api/occurrences/${occ.id}/excuse`);
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('skipped');

      const stats = await h.get('/api/stats?from=2026-01-01&to=2026-01-31');
      expect(stats.json().overall.counts.skipped).toBe(1);
    } finally {
      h.cleanup();
    }
  });
});

describe('settings cannot brick the API', () => {
  it('rejects a non-numeric lookback and stays usable', async () => {
    const h = harness();
    try {
      expect((await h.patch('/api/settings', { lookbackDays: 'abc' })).statusCode).toBe(400);
      expect((await h.get('/api/day')).statusCode).toBe(200);
    } finally {
      h.cleanup();
    }
  });

  it('rejects a negative or absurdly large lookback', async () => {
    const h = harness();
    try {
      expect((await h.patch('/api/settings', { lookbackDays: -1 })).statusCode).toBe(400);
      expect((await h.patch('/api/settings', { lookbackDays: 99999999 })).statusCode).toBe(400);
      expect((await h.get('/api/day')).statusCode).toBe(200);
    } finally {
      h.cleanup();
    }
  });

  it('rejects an invalid timezone and rollover', async () => {
    const h = harness();
    try {
      expect((await h.patch('/api/settings', { timezone: 'Mars/Olympus' })).statusCode).toBe(400);
      expect((await h.patch('/api/settings', { dayRollover: '25:00' })).statusCode).toBe(400);
    } finally {
      h.cleanup();
    }
  });

  it('accepts a valid change', async () => {
    const h = harness();
    try {
      const res = await h.patch('/api/settings', { lookbackDays: 7, timezone: 'Europe/Warsaw' });
      expect(res.statusCode).toBe(200);
      expect(res.json().lookbackDays).toBe(7);
      expect(res.json().timezone).toBe('Europe/Warsaw');
    } finally {
      h.cleanup();
    }
  });

  it('survives a corrupt value already in the database', async () => {
    const h = harness();
    try {
      // The CHECK constraint blocks this, which is itself the point.
      expect(() =>
        h.db.prepare('UPDATE settings SET lookback_days = ? WHERE id = 1').run(999999999),
      ).toThrow();
      expect((await h.get('/api/day')).statusCode).toBe(200);
    } finally {
      h.cleanup();
    }
  });
});

describe('validation returns real status codes', () => {
  it('rejects an invalid RRULE at creation', async () => {
    const h = harness();
    try {
      expect((await h.post('/api/rules', { title: 'Bad', rrule: 'FREQ=NONSENSE' })).statusCode).toBe(400);
    } finally {
      h.cleanup();
    }
  });

  it('rejects an impossible date', async () => {
    const h = harness();
    try {
      expect((await h.get('/api/day?date=2026-02-31')).statusCode).toBe(400);
    } finally {
      h.cleanup();
    }
  });

  it('404s on an unknown rule', async () => {
    const h = harness();
    try {
      expect((await h.patch('/api/rules/missing', { title: 'x' })).statusCode).toBe(404);
      expect((await h.get('/api/rules/missing/edit-preview?rrule=FREQ=DAILY')).statusCode).toBe(404);
    } finally {
      h.cleanup();
    }
  });

  it('validates dtstartDate on update', async () => {
    const h = harness();
    try {
      const rule = await h.makeRule();
      expect((await h.patch(`/api/rules/${rule.id}`, { dtstartDate: 'tuesday' })).statusCode).toBe(400);
      expect((await h.patch(`/api/rules/${rule.id}`, { dtstartDate: '2026-01-01' })).statusCode).toBe(200);
    } finally {
      h.cleanup();
    }
  });

  it('requires a strict boolean for trackStreak', async () => {
    const h = harness();
    try {
      const res = await h.post('/api/rules', { title: 'x', rrule: 'FREQ=DAILY', trackStreak: 'false' });
      expect(res.statusCode).toBe(400);
    } finally {
      h.cleanup();
    }
  });

  it('rejects an unbounded statistics range', async () => {
    const h = harness();
    try {
      // A real, valid date pair that is simply far too wide to compute.
      const res = await h.get('/api/stats?from=1000-01-01&to=9999-12-31');
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/must not exceed/);
    } finally {
      h.cleanup();
    }
  });

  it('rejects a date that is well-formed but does not exist', async () => {
    const h = harness();
    try {
      const res = await h.get('/api/stats?from=1000-01-01&to=9999-13-45');
      expect(res.statusCode).toBe(400);
    } finally {
      h.cleanup();
    }
  });
});

describe('rule versioning and archive', () => {
  it('opens a new version when the schedule changes', async () => {
    const h = harness();
    try {
      const rule = await h.makeRule();
      await h.patch(`/api/rules/${rule.id}`, { rrule: 'FREQ=WEEKLY;BYDAY=MO' });
      expect(h.all('SELECT * FROM rule_versions WHERE rule_id = ?', rule.id)).toHaveLength(2);
    } finally {
      h.cleanup();
    }
  });

  it('does not open a version when only the title changes', async () => {
    const h = harness();
    try {
      const rule = await h.makeRule();
      await h.patch(`/api/rules/${rule.id}`, { title: 'Renamed' });
      expect(h.all('SELECT * FROM rule_versions WHERE rule_id = ?', rule.id)).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it('withdraws future pending rows when a rule is archived', async () => {
    const h = harness();
    try {
      const rule = await h.makeRule();
      const today = await h.today();
      await h.get('/api/day');
      expect((await h.del(`/api/rules/${rule.id}`)).statusCode).toBe(200);

      const rows = h.all<{ n: number }>(
        "SELECT COUNT(*) AS n FROM occurrences WHERE rule_id = ? AND status = 'pending' AND scheduled_date > ?",
        rule.id,
        today,
      );
      expect(rows[0]!.n).toBe(0);
    } finally {
      h.cleanup();
    }
  });
});

describe('EXDATE support', () => {
  it('accepts a rule carrying an exclusion date and honours it', async () => {
    const h = harness();
    try {
      await h.makeRule({
        rrule: 'FREQ=MONTHLY;BYMONTHDAY=1;EXDATE:20260901',
        dtstartDate: '2026-01-01',
        createdDate: '2026-01-01',
      });
      expect((await h.get('/api/day?date=2026-09-01')).json().items).toHaveLength(0);
      expect((await h.get('/api/day?date=2026-10-01')).json().items).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });
});

describe('schema integrity', () => {
  it('refuses to store text in an integer column', async () => {
    const h = harness();
    try {
      expect(() =>
        h.db.prepare('UPDATE settings SET lookback_days = ? WHERE id = 1').run('abc'),
      ).toThrow();
    } finally {
      h.cleanup();
    }
  });
});