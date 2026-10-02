# ADR 0004 — Skip periods as ranges, excluded from adherence

**Status:** Accepted

---

## Context

People go on holiday, get ill, or take a week off on purpose. Without a mechanism
for that, a vacation is recorded as a 100% failure month, and the statistics
become an account of things that were not actually failures.

---

## Decision

A skip period is an **inclusive date range**, not a flag on each occurrence.

```
skip_periods (start_date, end_date, reason)
```

Three behaviours follow:

1. Occurrences inside the range are materialised `skipped`, never `missed`.
2. `skipped` is **excluded from the adherence denominator**:
   `adherence = done / (done + missed)`.
3. Completing an occurrence inside a skip period promotes it to `done`, and it
   counts as a success.

The skipped count is always displayed alongside adherence, so the denominator is
never hidden.

---

## Consequences

**Positive**

- Holidays do not count against the user.
- Working out while away still counts as a success — no special-casing, because
  `done` simply outranks `skipped` in the status ordering.
- One action to mark a holiday, rather than one per occurrence.

**Negative**

- The metric becomes gameable. Without a guard, "skip everything" yields a
  perfect score.
  **Mitigation:** the skipped count is always shown next to the result, so a
  month of 8 skipped days is never indistinguishable from a perfect one. Hiding
  the number would be cleaner-looking and dishonest.

---

## Alternatives considered

### Per-occurrence skip flags

More flexible, but nobody wants to tick 21 boxes to go on holiday. Flexibility
nobody uses is cost without benefit.

### Keep skipped in the denominator

Punishes holidays, which defeats the purpose.

### Extend streaks across skipped days

Dishonest — a holiday would inflate a streak.

### Break streaks on skipped days

Simple, but destroys a streak over a holiday, which is precisely the
demotivation that makes habit trackers fail people.

**Chosen: neutral.** A skipped day neither extends nor breaks a streak. This is
only expressible because `skipped` is a distinct state rather than an absence of
data.
