import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  addDays,
  isValidDate,
  isValidTime,
  isWithin,
  todayInTimeZone,
  validateRRule,
  type Occurrence,
  type Rule,
  type Settings,
} from '@takalif/core';
import type { DB } from './db.js';
import {
  archiveRule,
  buildPeriodReport,
  createRule,
  createSkipPeriod,
  deleteSkipPeriod,
  materialize,
  readOccurrences,
  readRules,
  readSettings,
  readSkipPeriods,
  setOccurrenceStatus,
  updateRule,
  updateSettings,
} from './repo.js';

const DATE_RANGE = /^\d{4}-\d{2}-\d{2}$/;

export function buildApp(db: DB): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(cors, { origin: true });

  /**
   * Every endpoint that reads or writes the ledger runs the generator first, so
   * a response is never stale with respect to the current time or the current
   * schedule. It is cheap (pure function over a bounded window) and idempotent.
   */
  const sync = () => materialize(db);

  const bad = (message: string) => ({ error: message });

  // -- settings -------------------------------------------------------------

  app.get('/api/settings', async () => readSettings(db));

  app.patch('/api/settings', async (req) => {
    const body = (req.body ?? {}) as Partial<Settings>;
    if (body.timezone !== undefined) {
      try {
        new Intl.DateTimeFormat('en', { timeZone: body.timezone });
      } catch {
        return bad(`Unknown IANA timezone: ${body.timezone}`);
      }
    }
    if (body.dayRollover !== undefined && !isValidTime(body.dayRollover)) {
      return bad('dayRollover must be HH:MM');
    }
    sync();
    return updateSettings(db, body);
  });

  // -- rules ----------------------------------------------------------------

  app.get('/api/rules', async () => {
    sync();
    return readRules(db, true);
  });

  app.post('/api/rules', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const title = String(body.title ?? '').trim();
    const rrule = String(body.rrule ?? '').trim();
    if (!title) return bad('title is required');
    if (!rrule) return bad('rrule is required');

    const settings = readSettings(db);
    const today = todayInTimeZone(settings.timezone, new Date());
    const dtstartDate = typeof body.dtstartDate === 'string' ? body.dtstartDate : today;

    if (!isValidDate(dtstartDate)) return bad('dtstartDate must be YYYY-MM-DD');
    if (!validateRRule(rrule, dtstartDate)) return bad(`Invalid or unsupported RRULE: ${rrule}`);
    if (body.dueTime != null && !isValidTime(String(body.dueTime))) {
      return bad('dueTime must be HH:MM');
    }

    const created = typeof body.createdDate === 'string' ? body.createdDate : today;
    if (!isValidDate(created)) return bad('createdDate must be YYYY-MM-DD');

    const rule = createRule(db, {
      title,
      description: (body.description as string) ?? null,
      rrule,
      dtstartDate,
      dueTime: (body.dueTime as string) ?? null,
      createdDate: created,
      trackStreak: Boolean(body.trackStreak),
      category: (body.category as string) ?? null,
    });

    sync();
    reply.code(201);
    return rule;
  });

  app.patch('/api/rules/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const settings = readSettings(db);
    const today = todayInTimeZone(settings.timezone, new Date());

    const effectiveFrom =
      typeof body.effectiveFrom === 'string' ? body.effectiveFrom : today;
    if (!isValidDate(effectiveFrom)) return bad('effectiveFrom must be YYYY-MM-DD');
    if (typeof body.rrule === 'string' && !validateRRule(body.rrule, effectiveFrom)) {
      return bad(`Invalid or unsupported RRULE: ${body.rrule}`);
    }
    if (body.dueTime != null && !isValidTime(String(body.dueTime))) {
      return bad('dueTime must be HH:MM');
    }

    const rule = updateRule(db, id, { ...(body as object), effectiveFrom } as never);
    if (!rule) return bad('Rule not found');

    sync();
    return rule;
  });

  /**
   * Dry run for a schedule change: reports which unlogged occurrences the new
   * schedule would add or withdraw, so the user can see it before it happens.
   */
  app.get('/api/rules/:id/edit-preview', async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { rrule?: string; dtstartDate?: string; effectiveFrom?: string };
    if (q.rrule && !validateRRule(q.rrule, q.effectiveFrom ?? q.dtstartDate ?? '2026-01-01')) {
      return bad(`Invalid or unsupported RRULE: ${q.rrule}`);
    }
    const { previewRuleEdit } = await import('./repo.js');
    return previewRuleEdit(db, id, {
      rrule: q.rrule,
      dtstartDate: q.dtstartDate,
      effectiveFrom: q.effectiveFrom ?? todayInTimeZone(readSettings(db).timezone, new Date()),
    });
  });

  app.delete('/api/rules/:id', async (req) => {
    const { id } = req.params as { id: string };
    return { archived: archiveRule(db, id) };
  });

  // -- occurrences ----------------------------------------------------------

  /** The primary view: what is due on a given day. */
  app.get('/api/day', async (req) => {
    const plan = sync();
    const q = req.query as { date?: string };
    const date = q.date ?? plan.today;
    if (!DATE_RANGE.test(date)) return bad('date must be YYYY-MM-DD');

    const settings = readSettings(db);
    const window = { from: date, to: date };
    const occurrences = readOccurrences(db, window.from, window.to);
    const rules = new Map(readRules(db, true).map((r) => [r.id, r]));

    return {
      date,
      today: plan.today,
      timezone: settings.timezone,
      items: occurrences.map((o) => decorate(o, rules)),
      recoveryPrompt: plan.recoveryPrompt,
    };
  });

  app.get('/api/occurrences', async (req) => {
    const plan = sync();
    const q = req.query as { from?: string; to?: string };
    const from = q.from ?? addDays(plan.today, -30);
    const to = q.to ?? addDays(plan.today, 30);
    if (!DATE_RANGE.test(from) || !DATE_RANGE.test(to)) {
      return bad('from and to must be YYYY-MM-DD');
    }
    const rules = new Map(readRules(db, true).map((r) => [r.id, r]));
    return readOccurrences(db, from, to).map((o) => decorate(o, rules));
  });

  app.post('/api/occurrences/:id/done', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { at?: string; note?: string };
    const occ = setOccurrenceStatus(db, id, 'done', body.at ?? new Date().toISOString());
    if (!occ) return bad('Occurrence is not pending, or does not exist');
    return occ;
  });

  app.post('/api/occurrences/:id/missed', async (req) => {
    const { id } = req.params as { id: string };
    const occ = setOccurrenceStatus(db, id, 'missed', null);
    if (!occ) return bad('Occurrence is not pending, or does not exist');
    return occ;
  });

  /** Undo a check-off. The only way out of a terminal state. */
  app.post('/api/occurrences/:id/reset', async (req) => {
    const { id } = req.params as { id: string };
    const result = db
      .prepare("UPDATE occurrences SET status = 'pending', completed_at = NULL, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    if (result.changes === 0) return bad('Occurrence does not exist');
    sync();
    return db.prepare('SELECT * FROM occurrences WHERE id = ?').get(id);
  });

  // -- skip periods ---------------------------------------------------------

  app.get('/api/skip-periods', async () => {
    sync();
    return readSkipPeriods(db);
  });

  app.post('/api/skip-periods', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const start = String(body.startDate ?? '');
    const end = String(body.endDate ?? start);
    if (!isValidDate(start) || !isValidDate(end)) return bad('startDate and endDate must be YYYY-MM-DD');
    if (end < start) return bad('endDate must not precede startDate');

    const period = createSkipPeriod(db, start, end, (body.reason as string) ?? null);
    // Apply it to the freshly-settled window immediately.
    const plan = sync();
    reply.code(201);
    return { period, prompt: plan.recoveryPrompt };
  });

  app.delete('/api/skip-periods/:id', async (req) => {
    const { id } = req.params as { id: string };
    const removed = deleteSkipPeriod(db, id);
    if (removed) sync();
    return { removed };
  });

  // -- statistics -----------------------------------------------------------

  app.get('/api/stats', async (req) => {
    const q = req.query as { from?: string; to?: string; preset?: string };
    const plan = sync();
    const today = plan.today;
    const range = resolveRange(q, today);
    if ('error' in range) return bad(range.error);
    return buildPeriodReport(db, range.from, range.to);
  });

  // -- health ---------------------------------------------------------------

  app.get('/api/health', async () => ({
    ok: true,
    today: todayInTimeZone(readSettings(db).timezone, new Date()),
  }));

  return app;
}

function decorate(
  o: Occurrence,
  rules: Map<string, Pick<Rule, 'title' | 'category'>>,
) {
  const rule = rules.get(o.ruleId);
  return {
    ...o,
    ruleTitle: rule?.title ?? '(archived)',
    category: rule?.category ?? null,
  };
}

function resolveRange(
  q: { from?: string; to?: string; preset?: string },
  today: string,
): { from: string; to: string } | { error: string } {
  const presets: Record<string, [number, number]> = {
    week: [0, 6],
    month: [0, 29],
    quarter: [0, 89],
    year: [0, 364],
  };

  if (q.from && q.to) {
    if (!DATE_RANGE.test(q.from) || !DATE_RANGE.test(q.to)) {
      return { error: 'from and to must be YYYY-MM-DD' };
    }
    if (q.to < q.from) return { error: 'to must not precede from' };
    return { from: q.from, to: q.to };
  }

  const preset = q.preset ?? 'month';
  const span = presets[preset];
  if (!span) return { error: `Unknown preset: ${preset}` };
  return { from: addDays(today, -span[0]), to: addDays(today, span[1]) };
}
