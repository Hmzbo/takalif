import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { runReminderTick, sendTestNotification, type PushConfig } from '../src/reminders.js';
import { harness } from './helpers.js';

const TEST_PUSH: PushConfig = { publicKey: 'test-public', privateKey: 'test-private' };

const TEST_SUB = {
  endpoint: 'https://push.example/sub-1',
  keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
};

describe('migrations', () => {
  it('adds reminder columns to a pre-existing database without losing data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'takalif-migrate-'));
    try {
      // A database as created before migration 1: same tables, fewer columns.
      const old = new Database(join(dir, 'old.sqlite'));
      old.exec(`
        CREATE TABLE settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          timezone TEXT NOT NULL DEFAULT 'UTC',
          day_rollover TEXT NOT NULL DEFAULT '04:00',
          lookback_days INTEGER NOT NULL DEFAULT 30,
          lookahead_days INTEGER NOT NULL DEFAULT 14,
          default_calendar TEXT NOT NULL DEFAULT 'gregorian',
          email TEXT
        ) STRICT;
        INSERT INTO settings (id, timezone) VALUES (1, 'Europe/Warsaw');
        CREATE TABLE rules (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT,
          rrule TEXT NOT NULL,
          dtstart_date TEXT NOT NULL,
          due_time TEXT,
          calendar TEXT NOT NULL DEFAULT 'gregorian',
          created_date TEXT NOT NULL,
          track_streak INTEGER NOT NULL DEFAULT 0,
          category TEXT,
          active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        INSERT INTO rules (id, title, rrule, dtstart_date, created_date, created_at, updated_at)
        VALUES ('r1', 'Kept', 'FREQ=DAILY', '2026-01-01', '2026-01-01', 'x', 'x');
        CREATE TABLE occurrences (
          id TEXT PRIMARY KEY,
          rule_id TEXT NOT NULL,
          rule_version INTEGER NOT NULL,
          scheduled_date TEXT NOT NULL,
          due_time TEXT,
          status TEXT NOT NULL,
          completed_at TEXT,
          note TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (rule_id, scheduled_date)
        ) STRICT;
      `);
      old.close();

      const migrated = openDatabase(join(dir, 'old.sqlite'));
      try {
        const cols = (table: string) =>
          (migrated.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
            (c) => c.name,
          );
        expect(cols('rules')).toContain('reminder_time');
        expect(cols('occurrences')).toContain('reminded_at');
        expect(cols('settings')).toContain('ntfy_topic');
        expect(cols('settings')).toContain('ntfy_server');
        // Rows survive the migration.
        expect(
          (migrated.prepare('SELECT title FROM rules WHERE id = ?').get('r1') as { title: string })
            .title,
        ).toBe('Kept');
        expect(
          (migrated.prepare('SELECT timezone FROM settings WHERE id = 1').get() as {
            timezone: string;
          }).timezone,
        ).toBe('Europe/Warsaw');
      } finally {
        migrated.close();
      }

      // Second open is a no-op, not an error.
      const reopened = openDatabase(join(dir, 'old.sqlite'));
      try {
        expect(
          (reopened.prepare('SELECT title FROM rules WHERE id = ?').get('r1') as { title: string })
            .title,
        ).toBe('Kept');
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('push subscriptions', () => {
  it('answers 503 while push is unconfigured', async () => {
    const h = harness();
    try {
      expect((await h.get('/api/push/public-key')).statusCode).toBe(503);
      expect((await h.post('/api/push/subscribe', TEST_SUB)).statusCode).toBe(503);
    } finally {
      h.cleanup();
    }
  });

  it('subscribes, upserts and unsubscribes', async () => {
    const h = harness(undefined, TEST_PUSH);
    try {
      expect((await h.get('/api/push/public-key')).json()).toEqual({ publicKey: 'test-public' });

      const first = await h.post('/api/push/subscribe', TEST_SUB);
      expect(first.statusCode).toBe(201);
      expect(first.json()).toMatchObject({ subscribed: true, endpoint: TEST_SUB.endpoint });

      // Re-subscribing refreshes keys instead of duplicating the endpoint.
      const second = await h.post('/api/push/subscribe', {
        endpoint: TEST_SUB.endpoint,
        keys: { p256dh: 'new-key', auth: 'new-auth' },
      });
      expect(second.statusCode).toBe(201);
      const rows = h.all<{ p256dh: string }>('SELECT p256dh FROM push_subscriptions');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.p256dh).toBe('new-key');

      expect(
        (await h.del('/api/push/unsubscribe', { endpoint: TEST_SUB.endpoint })).json(),
      ).toEqual({ removed: true });
      expect(
        (await h.del('/api/push/unsubscribe', { endpoint: TEST_SUB.endpoint })).statusCode,
      ).toBe(404);
    } finally {
      h.cleanup();
    }
  });

  it('validates subscription bodies', async () => {
    const h = harness(undefined, TEST_PUSH);
    try {
      expect((await h.post('/api/push/subscribe', {})).statusCode).toBe(400);
      expect(
        (await h.post('/api/push/subscribe', { endpoint: 'not-a-url', keys: TEST_SUB.keys }))
          .statusCode,
      ).toBe(400);
      expect((await h.post('/api/push/subscribe', { endpoint: TEST_SUB.endpoint })).statusCode).toBe(
        400,
      );
      expect(
        (
          await h.post('/api/push/subscribe', {
            endpoint: TEST_SUB.endpoint,
            keys: { p256dh: '', auth: '' },
          })
        ).statusCode,
      ).toBe(400);
      expect((await h.del('/api/push/unsubscribe', {})).statusCode).toBe(400);
    } finally {
      h.cleanup();
    }
  });

  it('answers 503 for a test with no channel configured', async () => {
    const h = harness(undefined, TEST_PUSH);
    try {
      const res = await h.post('/api/push/test', {});
      expect(res.statusCode).toBe(503);
    } finally {
      h.cleanup();
    }
  });
});

describe('rule reminder time', () => {
  it('round-trips through create and update, and never opens a version', async () => {
    const NOW = new Date('2026-10-03T12:00:00Z');
    const h = harness(() => new Date(NOW));
    try {
      const rule = await h.makeRule({ reminderTime: '07:30' });
      expect(rule.reminderTime).toBe('07:30');

      await h.patch(`/api/rules/${rule.id}`, { reminderTime: '08:00' });
      const versions = h.all('SELECT version FROM rule_versions WHERE rule_id = ?', rule.id);
      // A reminder is metadata, not a schedule change: still exactly version 1.
      expect(versions).toHaveLength(1);
      const stored = h.all<{ reminder_time: string }>(
        'SELECT reminder_time FROM rules WHERE id = ?',
        rule.id,
      )[0]!;
      expect(stored.reminder_time).toBe('08:00');

      // Empty clears it.
      await h.patch(`/api/rules/${rule.id}`, { reminderTime: '' });
      expect(
        h.all<{ reminder_time: string | null }>(
          'SELECT reminder_time FROM rules WHERE id = ?',
          rule.id,
        )[0]!.reminder_time,
      ).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it('rejects a non-time reminder', async () => {
    const h = harness();
    try {
      expect(
        (await h.post('/api/rules', { title: 'x', rrule: 'FREQ=DAILY', reminderTime: '25:00' }))
          .statusCode,
      ).toBe(400);
    } finally {
      h.cleanup();
    }
  });
});

describe('settings notifications', () => {
  it('validates ntfy fields and persists them', async () => {
    const h = harness();
    try {
      expect((await h.patch('/api/settings', { ntfyTopic: 'has spaces!' })).statusCode).toBe(400);
      expect((await h.patch('/api/settings', { ntfyTopic: '' })).statusCode).toBe(400);
      expect((await h.patch('/api/settings', { ntfyServer: 'gopher://x' })).statusCode).toBe(400);

      const res = await h.patch('/api/settings', {
        ntfyTopic: 'takalif-test',
        ntfyServer: 'https://ntfy.example',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ntfyTopic).toBe('takalif-test');
      expect(res.json().ntfyServer).toBe('https://ntfy.example');
    } finally {
      h.cleanup();
    }
  });
});

describe('reminder scheduling', () => {
  function sentPayloads() {
    const payloads: string[] = [];
    return {
      payloads,
      push: {
        send: async (_sub: unknown, payload: string) => {
          payloads.push(payload);
        },
      },
    };
  }

  it('fires once the reminder time passes, then never again', async () => {
    const h = harness(() => new Date('2026-10-03T06:59:00Z'), TEST_PUSH);
    try {
      await h.makeRule({ reminderTime: '07:00' });
      await h.post('/api/push/subscribe', TEST_SUB);
      const { payloads, push } = sentPayloads();

      expect(
        await runReminderTick(h.db, TEST_PUSH, new Date('2026-10-03T06:59:00Z'), { push }),
      ).toMatchObject({ checked: 0, sent: 0 });

      const due = await runReminderTick(h.db, TEST_PUSH, new Date('2026-10-03T07:00:00Z'), {
        push,
      });
      expect(due).toMatchObject({ checked: 1, sent: 1, failed: 0 });
      expect(JSON.parse(payloads[0]!)).toMatchObject({ title: 'Workout' });

      // Second tick finds it already reminded.
      expect(
        await runReminderTick(h.db, TEST_PUSH, new Date('2026-10-03T07:30:00Z'), { push }),
      ).toMatchObject({ checked: 0, sent: 0 });
      expect(payloads).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it('ignores rows that are not pending and rules without a reminder', async () => {
    const h = harness(() => new Date('2026-10-03T12:00:00Z'));
    try {
      const workout = await h.makeRule({ reminderTime: '07:00' });
      await h.makeRule({ title: 'Silent', rrule: 'FREQ=DAILY' });
      const { push } = sentPayloads();

      // Today's pending row for the reminding rule is due (07:00 long past).
      const tick = await runReminderTick(h.db, TEST_PUSH, new Date('2026-10-03T12:00:00Z'), {
        push,
      });
      expect(tick.checked).toBe(1);

      // Completing the reminding rule's row removes it from future ticks.
      const rows = (await h.get('/api/occurrences?from=2026-10-03&to=2026-10-03')).json() as {
        id: string;
        ruleId: string;
      }[];
      const occ = rows.find((r) => r.ruleId === workout.id);
      expect(occ, 'expected the Workout row for today').toBeTruthy();
      expect((await h.post(`/api/occurrences/${occ!.id}/done`, {})).statusCode).toBe(200);
      const again = await runReminderTick(h.db, TEST_PUSH, new Date('2026-10-03T12:30:00Z'), {
        push,
      });
      expect(again.checked).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  it('prunes dead subscriptions and keeps going', async () => {
    const h = harness(() => new Date('2026-10-03T07:00:00Z'), TEST_PUSH);
    try {
      await h.makeRule({ reminderTime: '07:00' });
      await h.post('/api/push/subscribe', TEST_SUB);
      await h.post('/api/push/subscribe', {
        endpoint: 'https://push.example/gone',
        keys: { p256dh: 'k', auth: 'a' },
      });

      const push = {
        send: async (sub: { endpoint: string }) => {
          if (sub.endpoint.endsWith('/gone')) {
            throw Object.assign(new Error('gone'), { statusCode: 410 });
          }
        },
      };
      const result = await runReminderTick(h.db, TEST_PUSH, new Date('2026-10-03T07:00:00Z'), {
        push,
      });
      expect(result).toMatchObject({ checked: 1, sent: 1, pruned: 1 });
      expect(h.all('SELECT endpoint FROM push_subscriptions')).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it('posts to ntfy when configured, even with no subscriptions', async () => {
    const h = harness(() => new Date('2026-10-03T07:00:00Z'));
    try {
      await h.makeRule({ reminderTime: '07:00' });

      const posts: { url: string; title: string }[] = [];
      const fetchImpl = (async (url: string, init?: { headers?: Record<string, string> }) => {
        posts.push({ url, title: init?.headers?.['Title'] ?? '' });
        return { ok: true, status: 200 };
      }) as unknown as typeof fetch;

      // Nothing configured at all: found but not sent, rows stay unmarked so
      // a later-configured channel still fires for them.
      const idle = await runReminderTick(h.db, {}, new Date('2026-10-03T07:00:00Z'), {
        fetchImpl,
      });
      expect(idle).toMatchObject({ checked: 1, sent: 0 });
      expect(posts).toHaveLength(0);
      expect(
        h.all<{ n: number }>('SELECT COUNT(*) AS n FROM occurrences WHERE reminded_at IS NULL')[0]!
          .n,
      ).toBeGreaterThan(0);

      await h.patch('/api/settings', { ntfyTopic: 'takalif-test' });
      const result = await runReminderTick(h.db, {}, new Date('2026-10-03T07:00:00Z'), {
        fetchImpl,
      });
      expect(result).toMatchObject({ checked: 1, sent: 1, failed: 0 });
      expect(posts).toHaveLength(1);
      expect(posts[0]!.url).toBe('https://ntfy.sh/takalif-test');

      // Marked now: a repeat tick finds nothing.
      const again = await runReminderTick(h.db, {}, new Date('2026-10-03T08:00:00Z'), {
        fetchImpl,
      });
      expect(again).toMatchObject({ checked: 0, sent: 0 });
      expect(posts).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it('sends a test notification through configured channels', async () => {
    const h = harness(undefined, TEST_PUSH);
    try {
      await h.post('/api/push/subscribe', TEST_SUB);
      const sent: string[] = [];
      // Route-level: the test endpoint uses the real sender, so exercise the
      // orchestration directly with a fake instead.
      const result = await sendTestNotification(h.db, TEST_PUSH, {
        push: {
          send: async (_s: unknown, p: string) => {
            sent.push(p);
          },
        },
      });
      expect(result.sent).toBe(1);
      expect(JSON.parse(sent[0]!)).toMatchObject({ title: 'Takalif' });
    } finally {
      h.cleanup();
    }
  });
});
