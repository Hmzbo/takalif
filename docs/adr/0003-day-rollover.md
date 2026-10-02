# ADR 0003 — A day closes at a rollover time, not midnight

**Status:** Accepted

---

## Context

Once occurrences are materialised, something must decide when a `pending` day
becomes `missed`. The obvious answer — local midnight — is wrong.

Sweep at local midnight, and every task done after dinner counts as a failure. An
evening habit would show a permanent 100% failure rate, which is not a limitation
of the data: it is an artefact of where the boundary was drawn.

---

## Decision

The occurrence for date `D` stays open until `D+1` at a configurable
`day_rollover`, defaulting to `04:00`, in the user's configured timezone.

```
scheduled_date = 2026-09-29
day_rollover   = 04:00
timezone       = Europe/Warsaw

closes at  2026-09-30T02:00:00Z
```

Timezone decides *which bucket* a moment falls into. The rollover decides *when
that bucket closes*. Both are required, and they are orthogonal.

---

## Consequences

**Positive**

- Work done late in the evening is not recorded as failure.
- The boundary is a user setting, so it can be tuned rather than imposed.
- Closing time is computed in the user's zone, so it is correct regardless of
  where the server runs.

**Negative**

- An additional setting to explain.
- Timezone arithmetic enters the hot path. Contained in `zonedTimeToUtc`, which
  handles both the spring-forward gap and the fall-back ambiguity, both tested.

---

## Alternatives considered

### Local midnight

Rejected above. The failure mode is systematic, not occasional.

### Configurable per rule

More expressive, but multiplies the settings surface for little gain. A per-user
default with an optional per-rule `due_time` covers the real cases: the rollover
handles "I finished late", and `due_time` handles "this was meant to be done by
09:00".

### No sweep; require explicit action

Means stale `pending` rows accumulate silently and statistics are quietly wrong
for anyone who forgets. An automatic sweep with a recovery prompt is safer.

---

## Related

The Islamic fasting day runs from sunset to dawn rather than midnight to
midnight. Shifting the boundary per rule would model that correctly; see
[ADR 0005](0005-multi-calendar-support.md) for the deferred work.
