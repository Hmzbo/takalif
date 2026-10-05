import { describe, expect, it } from 'vitest';
import { harness } from './helpers.js';

const NOW = () => new Date('2026-10-05T12:00:00Z');

describe('export', () => {
  it('exports a versioned JSON backup containing rules, versions and the ledger', async () => {
    const h = harness(NOW);
    try {
      await h.makeRule({ title: 'Workout' });
      const today = await h.today();
      const occ = await h.occurrenceOn(today);
      expect(occ, 'expected a materialised occurrence').toBeTruthy();

      const res = await h.get('/api/export/json');
      expect(res.statusCode).toBe(200);
      const doc = res.json();
      expect(doc.version).toBe(1);
      expect(doc.exportedAt).toBeTruthy();
      expect(doc.rules).toHaveLength(1);
      expect(doc.rules[0].title).toBe('Workout');
      expect(doc.ruleVersions).toHaveLength(1);
      expect(doc.occurrences.length).toBeGreaterThan(0);
      expect(doc.settings.timezone).toBeTruthy();
      // Device endpoints are not user data and must not leak into backups.
      expect(doc).not.toHaveProperty('pushSubscriptions');
    } finally {
      h.cleanup();
    }
  });

  it('exports the ledger as CSV with a header and one row per occurrence', async () => {
    const h = harness(NOW);
    try {
      await h.makeRule({ title: 'Workout' });
      const today = await h.today();
      const res = await h.get(`/api/export/csv?from=${today}&to=${today}`);
      expect(res.statusCode).toBe(200);
      const lines = res.body.trim().split('\n');
      expect(lines[0]).toBe(
        'rule_id,rule_title,scheduled_date,status,due_time,completed_at,rule_version,calendar,category',
      );
      expect(lines.length).toBeGreaterThan(1);
      expect(res.body).toContain('Workout');
    } finally {
      h.cleanup();
    }
  });

  it('exports schedules as VTODOs with stable UIDs and RRULEs', async () => {
    const h = harness(NOW);
    try {
      const rule = await h.makeRule({ title: 'Workout', rrule: 'FREQ=DAILY' });
      const raw = await h.app.inject({ method: 'GET', url: '/api/export/vtodo' });
      expect(raw.statusCode).toBe(200);
      expect(raw.headers['content-type']).toContain('text/calendar');
      expect(raw.body).toContain('BEGIN:VTODO');
      expect(raw.body).toContain(`UID:${rule.id}@takalif`);
      expect(raw.body).toContain('RRULE:FREQ=DAILY');
    } finally {
      h.cleanup();
    }
  });
});

describe('import', () => {
  it('restores a backup round-trip, preserving terminal rows', async () => {
    const h = harness(NOW);
    try {
      await h.makeRule({ title: 'Workout' });
      const today = await h.today();
      const occ = await h.occurrenceOn(today);
      expect((await h.post(`/api/occurrences/${occ.id}/done`)).statusCode).toBe(200);

      const backup = (await h.get('/api/export/json')).json();

      // Prove restore replaces rather than merges: this rule must be gone after.
      await h.makeRule({ title: 'Temporary' });
      expect(h.all<{ n: number }>('SELECT COUNT(*) AS n FROM rules')[0]!.n).toBe(2);

      const res = await h.post('/api/import/json', backup);
      expect(res.statusCode, `restore failed: ${res.body}`).toBe(200);
      expect(res.json().restored).toBe(true);
      expect(res.json().rules).toBe(1);

      expect(h.all<{ n: number }>('SELECT COUNT(*) AS n FROM rules')[0]!.n).toBe(1);
      const stored = h.all<{ status: string }>(
        'SELECT status FROM occurrences WHERE scheduled_date = ?',
        today,
      )[0]!;
      expect(stored.status).toBe('done');
    } finally {
      h.cleanup();
    }
  });

  it('rejects a corrupt backup with 400 and writes nothing', async () => {
    const h = harness(NOW);
    try {
      await h.makeRule({ title: 'Workout' });
      const before = h.all<{ n: number }>('SELECT COUNT(*) AS n FROM rules')[0]!.n;

      const res = await h.post('/api/import/json', { version: 99 });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/version/i);

      const after = h.all<{ n: number }>('SELECT COUNT(*) AS n FROM rules')[0]!.n;
      expect(after).toBe(before);
    } finally {
      h.cleanup();
    }
  });

  it('rejects an occurrence that references an unknown rule', async () => {
    const h = harness(NOW);
    try {
      await h.makeRule({ title: 'Workout' });
      const backup = (await h.get('/api/export/json')).json();
      backup.occurrences.push({ ...backup.occurrences[0], id: 'evil', ruleId: 'ghost' });

      const res = await h.post('/api/import/json', backup);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/unknown rule/);
    } finally {
      h.cleanup();
    }
  });

  it('rejects history invented from before a rule was created', async () => {
    const h = harness(NOW);
    try {
      await h.makeRule({ title: 'Workout', createdDate: '2026-10-01', dtstartDate: '2026-10-01' });
      const backup = (await h.get('/api/export/json')).json();
      const before = h.all<{ n: number }>('SELECT COUNT(*) AS n FROM occurrences')[0]!.n;
      backup.occurrences.push({ ...backup.occurrences[0], id: 'early', scheduledDate: '2026-01-01' });

      const res = await h.post('/api/import/json', backup);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/createdDate/);
      expect(h.all<{ n: number }>('SELECT COUNT(*) AS n FROM occurrences')[0]!.n).toBe(before);
    } finally {
      h.cleanup();
    }
  });
});
