import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { openDatabase, type DB } from '../src/db.js';
import type { PushConfig } from '../src/reminders.js';

export interface Reply {
  statusCode: number;
  body: string;
  json: () => any;
}

export interface Harness {
  app: FastifyInstance;
  db: DB;
  post: (url: string, body?: unknown) => Promise<Reply>;
  patch: (url: string, body: unknown) => Promise<Reply>;
  del: (url: string, body?: unknown) => Promise<Reply>;
  get: (url: string) => Promise<Reply>;
  makeRule: (over?: Record<string, unknown>) => Promise<any>;
  occurrenceOn: (date: string) => Promise<any>;
  today: () => Promise<string>;
  all: <T = Record<string, unknown>>(sql: string, ...params: unknown[]) => T[];
  cleanup: () => void;
}

export function harness(now?: () => Date, push?: PushConfig): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'takalif-test-'));
  const db = openDatabase(join(dir, 'test.sqlite'));
  const app = buildApp(db, { logger: false, now, push });

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
    del: async (url, body?: unknown) =>
      wrap(
        await app.inject({
          method: 'DELETE',
          url,
          ...(body === undefined
            ? {}
            : { payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
        }),
      ),
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
