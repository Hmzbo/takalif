import type { LocalDate } from './dates.js';
import type { GeneratorPlan } from './generator.js';
import type { Occurrence, OccurrenceStatus } from './types.js';

function key(ruleId: string, scheduledDate: LocalDate): string {
  return `${ruleId}|${scheduledDate}`;
}

/**
 * Apply a plan to an in-memory occurrence list.
 *
 * Pure: returns a new list and never mutates its input. The server applies the
 * plan directly against SQL, but tests use this to simulate persistence, which
 * is what makes the idempotency invariant testable for real rather than in
 * principle.
 */
export function applyPlan(
  plan: GeneratorPlan,
  occurrences: Occurrence[],
  newId: () => string,
): Occurrence[] {
  const byKey = new Map<string, Occurrence>();
  const keyById = new Map<string, string>();
  for (const occ of occurrences) {
    const k = key(occ.ruleId, occ.scheduledDate);
    byKey.set(k, { ...occ });
    keyById.set(occ.id, k);
  }

  // Deletes first, so that a toDelete followed by a toInsert of the same key
  // resolves in favour of the insert.
  for (const del of plan.toDelete) byKey.delete(key(del.ruleId, del.scheduledDate));

  for (const planned of plan.toInsert) {
    const k = key(planned.ruleId, planned.scheduledDate);
    if (byKey.has(k)) continue;
    byKey.set(k, {
      id: newId(),
      ruleId: planned.ruleId,
      ruleVersion: planned.ruleVersion,
      scheduledDate: planned.scheduledDate,
      dueTime: planned.dueTime,
      status: planned.status,
      completedAt: null,
      note: null,
    });
    keyById.set(byKey.get(k)!.id, k);
  }

  for (const update of [...plan.toUpdate, ...plan.sweep]) {
    const k = keyById.get(update.id);
    if (k === undefined) continue;
    const occ = byKey.get(k);
    if (!occ) continue;
    // Terminal states are frozen: nothing downstream may rewrite history.
    if (occ.status !== 'pending') continue;
    occ.status = update.status;
    if (update.note !== undefined) occ.note = update.note;
  }

  return [...byKey.values()].sort(
    (a, b) =>
      a.scheduledDate.localeCompare(b.scheduledDate) || a.ruleId.localeCompare(b.ruleId),
  );
}

/** Mark an occurrence completed. Throws on anything already terminal. */
export function completeOccurrence(occ: Occurrence, completedAt: string): Occurrence {
  if (occ.status !== 'pending') {
    throw new Error(`Occurrence ${occ.id} is ${occ.status} and cannot be completed`);
  }
  return { ...occ, status: 'done' as OccurrenceStatus, completedAt };
}

export function occurrencesFor(occurrences: Occurrence[], ruleId: string): Occurrence[] {
  return occurrences
    .filter((o) => o.ruleId === ruleId)
    .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate));
}

export function datesOf(occurrences: Occurrence[]): LocalDate[] {
  return occurrences.map((o) => o.scheduledDate).sort();
}
