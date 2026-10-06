import { describe, expect, it } from 'vitest';
import { harness } from './helpers.js';

const NOW = () => new Date('2026-10-05T12:00:00Z');

describe('occurrence notes', () => {
  it('sets a note on a pending occurrence', async () => {
    const h = harness(NOW);
    try {
      await h.makeRule();
      const occ = await h.occurrenceOn(await h.today());

      const res = await h.post(`/api/occurrences/${occ.id}/note`, { note: 'gym instead' });
      expect(res.statusCode, `note failed: ${res.body}`).toBe(200);
      expect(res.json().note).toBe('gym instead');
    } finally {
      h.cleanup();
    }
  });

  it('allows notes on terminal rows: annotation, not ledger state', async () => {
    const h = harness(NOW);
    try {
      await h.makeRule();
      const occ = await h.occurrenceOn(await h.today());
      expect((await h.post(`/api/occurrences/${occ.id}/done`)).statusCode).toBe(200);

      const res = await h.post(`/api/occurrences/${occ.id}/note`, { note: 'felt strong' });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('done');
      expect(res.json().note).toBe('felt strong');
    } finally {
      h.cleanup();
    }
  });

  it('clears a note with null and survives the next sync', async () => {
    const h = harness(NOW);
    try {
      await h.makeRule();
      const occ = await h.occurrenceOn(await h.today());
      await h.post(`/api/occurrences/${occ.id}/note`, { note: 'x' });
      expect((await h.post(`/api/occurrences/${occ.id}/note`, { note: null })).json().note).toBeNull();

      await h.get('/api/day');
      const stored = h.all<{ note: string | null }>(
        'SELECT note FROM occurrences WHERE id = ?',
        occ.id,
      )[0]!;
      expect(stored.note).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it('rejects a note over 500 characters and an unknown id', async () => {
    const h = harness(NOW);
    try {
      await h.makeRule();
      const occ = await h.occurrenceOn(await h.today());

      const tooLong = await h.post(`/api/occurrences/${occ.id}/note`, { note: 'x'.repeat(501) });
      expect(tooLong.statusCode).toBe(400);

      const missing = await h.post('/api/occurrences/nope/note', { note: 'x' });
      expect(missing.statusCode).toBe(404);
    } finally {
      h.cleanup();
    }
  });

  it('stores the trimmed note and rejects a missing key instead of clearing', async () => {
    const h = harness(NOW);
    try {
      await h.makeRule();
      const occ = await h.occurrenceOn(await h.today());

      const res = await h.post(`/api/occurrences/${occ.id}/note`, { note: '  gym instead  ' });
      expect(res.statusCode).toBe(200);
      expect(res.json().note).toBe('gym instead');

      const noKey = await h.post(`/api/occurrences/${occ.id}/note`, {});
      expect(noKey.statusCode).toBe(400);
      const stored = h.all<{ note: string | null }>(
        'SELECT note FROM occurrences WHERE id = ?',
        occ.id,
      )[0]!;
      expect(stored.note).toBe('gym instead');
    } finally {
      h.cleanup();
    }
  });
});
