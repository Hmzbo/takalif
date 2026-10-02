# ADR 0001 — Lazy materialization and versioned schedules

**Status:** Accepted

---

## Context

To report "how many workouts did I miss in October?", the application must know
how many were **expected** in October. "Expected" is not derivable from what the
user logged — it is a property of the schedule. So it must either exist as data,
or be recomputed on demand.

Three approaches were evaluated.

---

## Decision

**Lazy materialization, plus versioned schedules.**

Do not pre-generate occurrences on a schedule. Instead, on every read or write
that touches the ledger, run a pure planner over a bounded window:

```
window = [today - lookbackDays, today + lookaheadDays]
```

The planner is idempotent and returns a plan that the caller applies atomically.

Every occurrence records which `rule_version` produced it. Editing a rule opens a
new version with an `effective_from` date; occurrences with a terminal status are
never regenerated.

---

## Alternatives considered

### 1. Materialize up front

Creating a rule generates all its occurrences immediately, through some future
horizon.

- **For:** the ledger is always complete; statistics are trivial queries.
- **Against:** the task list fills with ghosts. Return after three weeks and
  there are 21 `pending` rows. Something must sweep them, and a holiday becomes a
  100% failure month unless a skip concept is bolted on.
- Also requires a scheduler to keep generating the future, which needs a place to
  run and a story for a server that was down.

### 2. No materialization; expand on read

Store only the rule and a log of what actually happened. Expand the RRULE at
query time and diff it against the records.

- **For:** no ghosts, nothing to reconcile, tiny table.
- **Against — disqualifying:** editing a rule silently rewrites history. Loosen
  Workout from daily to three times a week, and October's adherence *recomputes*
  upward against the new rule. The past becomes a lie, and an undetectable one.

This is precisely the bug that quota-based habit trackers have structurally.

---

## Consequences

**Positive**

- Statistics are correct: the expected set is real data.
- No graveyard: the window is bounded.
- History survives schedule edits: settled rows keep their version.
- Rule editing is well-defined rather than mysterious.

**Negative**

- Reconciliation must be correct, and it is the hardest code in the project.
  Mitigated by making the planner pure and table-driven testable.
- Table growth. Accepted as a non-issue: five daily rules produce ~1,800 rows a
  year, which is negligible for SQLite.

---

## The test that gates this decision

> Edit a rule six months in the past, loosening `FREQ=DAILY` to
> `FREQ=MONTHLY;BYMONTHDAY=1`. Assert that **zero** terminal rows changed and
> only future pending rows were inserted or withdrawn.

If that test passes, the decision is proven. It lives in
`packages/core/test/generator.test.ts`.
