import { describe, expect, it } from 'vitest';
import { harness } from './helpers.js';

const NOW = () => new Date('2026-10-05T12:00:00Z');

describe('status changes on an open day', () => {
  it('moves done back to missed and clears completedAt', async () => {
    const h = harness(NOW);
    try {
      await h.makeRule();
      const occ = await h.occurrenceOn(await h.today());
      expect((await h.post(`/api/occurrences/${occ.id}/done`)).statusCode).toBe(200);

      const res = await h.post(`/api/occurrences/${occ.id}/status`, { status: 'missed' });
      expect(res.statusCode, `failed: ${res.body}`).toBe(200);
      expect(res.json().status).toBe('missed');
      expect(res.json().completedAt).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it('moves done to skipped and skipped to done (promotion)', async () => {
    const h = harness(NOW);
    try {
      await h.makeRule();
      const occ = await h.occurrenceOn(await h.today());
      await h.post(`/api/occurrences/${occ.id}/done`);

      const skip = await h.post(`/api/occurrences/${occ.id}/status`, { status: 'skipped' });
      expect(skip.json().status).toBe('skipped');

      const promote = await h.post(`/api/occurrences/${occ.id}/status`, { status: 'done' });
      expect(promote.json().status).toBe('done');
      expect(promote.json().completedAt).toBeTruthy();
    } finally {
      h.cleanup();
    }
  });

  it('locks everything once the day has closed', async () => {
    const h = harness(NOW);
    try {
      // Widen the window and backdate so a settled, closed day exists.
      await h.patch('/api/settings', { lookbackDays: 3660 });
      await h.makeRule({ createdDate: '2026-01-01', dtstartDate: '2026-01-01' });
      const res = await h.get('/api/occurrences?from=2026-01-05&to=2026-01-05');
      const closed = res.json()[0];
      expect(closed, 'expected a closed occurrence').toBeTruthy();
      expect(closed.status).toBe('missed');

      const done = await h.post(`/api/occurrences/${closed.id}/status`, { status: 'done' });
      expect(done.statusCode).toBe(409);
      expect(done.json().error).toMatch(/locked/);

      const skipped = await h.post(`/api/occurrences/${closed.id}/status`, {
        status: 'skipped',
      });
      expect(skipped.statusCode).toBe(409);
    } finally {
      h.cleanup();
    }
  });

  it('rejects an unknown status and an unknown id', async () => {
    const h = harness(NOW);
    try {
      await h.makeRule();
      const occ = await h.occurrenceOn(await h.today());

      const bad = await h.post(`/api/occurrences/${occ.id}/status`, { status: 'pending' });
      expect(bad.statusCode).toBe(400);

      const ghost = await h.post('/api/occurrences/nope/status', { status: 'done' });
      expect(ghost.statusCode).toBe(404);
    } finally {
      h.cleanup();
    }
  });

  it('takes a pending row to done and stamps completedAt', async () => {
    const h = harness(NOW);
    try {
      await h.makeRule();
      const occ = await h.occurrenceOn(await h.today());

      const res = await h.post(`/api/occurrences/${occ.id}/status`, { status: 'done' });
      expect(res.statusCode, `failed: ${res.body}`).toBe(200);
      expect(res.json().status).toBe('done');
      expect(res.json().completedAt).toBeTruthy();
    } finally {
      h.cleanup();
    }
  });

  it('a user-set status survives the next materialisation sweep', async () => {
    const h = harness(NOW);
    try {
      await h.makeRule();
      const occ = await h.occurrenceOn(await h.today());
      expect((await h.post(`/api/occurrences/${occ.id}/status`, { status: 'skipped' })).statusCode).toBe(200);

      // Any ledger read runs the generator; the sweep must leave a settled row alone.
      await h.get('/api/day');
      await h.get('/api/day');

      const stored = h.all<{ status: string; completed_at: string | null }>(
        'SELECT status, completed_at FROM occurrences WHERE id = ?',
        occ.id,
      )[0]!;
      expect(stored.status).toBe('skipped');
    } finally {
      h.cleanup();
    }
  });
});
