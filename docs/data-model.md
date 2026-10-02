# Data model

SQLite. `journal_mode = WAL`, `foreign_keys = ON`.

Schema lives in `packages/server/src/schema.sql`.

> **Status note.** The schema below describes the design. Multi-calendar support
> is designed but not yet implemented; the `rules.calendar` column does not exist
> in `schema.sql` yet. Everything else matches the current code.

---

## 1. Entities

### `settings` — singleton

| Column | Type | Notes |
|---|---|---|
| `timezone` | TEXT | IANA zone, e.g. `Europe/Warsaw`. **Server-side, never read from the device** |
| `day_rollover` | TEXT | `HH:MM`, default `04:00` |
| `lookback_days` | INTEGER | Days before today the generator materialises. Default `30` |
| `lookahead_days` | INTEGER | Days after today. Default `14` |
| `email` | TEXT | Optional destination for fallback reminders |

### `rules`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `title` | TEXT | |
| `description` | TEXT | |
| `rrule` | TEXT | RFC 5545 value, e.g. `FREQ=WEEKLY;BYDAY=TU;INTERVAL=2` |
| `dtstart_date` | TEXT | Local civil date the schedule starts |
| `due_time` | TEXT | Optional `HH:MM`; enables lateness |
| `created_date` | TEXT | Local civil date the rule was created |
| `track_streak` | INTEGER | Opt-in. Streaks are off by default |
| `calendar` | TEXT | Per-rule calendar. **Planned, not yet implemented** — see [ADR 0005](adr/0005-multi-calendar-support.md) |
| `category` | TEXT | |
| `active` | INTEGER | Soft delete. History is always preserved |
| `created_at` / `updated_at` | TEXT | ISO timestamps |

### `rule_versions`

The mechanism that keeps history honest.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `rule_id` | TEXT FK | Cascade on rule delete |
| `version` | INTEGER | Monotonic per rule |
| `rrule` | TEXT | Snapshot at time of edit |
| `dtstart_date` | TEXT | |
| `effective_from` | TEXT | Local civil date this version becomes authoritative |
| `created_at` | TEXT | |

Unique on `(rule_id, version)`, indexed on `(rule_id, effective_from)`.

**Editing a rule closes the current version and opens a new one.** Every
occurrence records the version that produced it, so historical rows are never
reinterpreted when a schedule changes.

### `occurrences` — the ledger

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `rule_id` | TEXT FK | |
| `rule_version` | INTEGER | Which version generated this row |
| `scheduled_date` | TEXT | **Local civil date. Never a UTC instant.** |
| `due_time` | TEXT | Copied from the rule at generation |
| `status` | TEXT | `pending` \| `done` \| `missed` \| `skipped` |
| `completed_at` | TEXT | |
| `note` | TEXT | |
| `created_at` / `updated_at` | TEXT | |

Unique on `(rule_id, scheduled_date)` — this is what makes the generator
idempotent and prevents two rows for the same expectation.

Indexes on `(scheduled_date)`, `(rule_id, status)` and
`(rule_id, scheduled_date, status)`.

### `skip_periods`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `start_date` / `end_date` | TEXT | Inclusive |
| `reason` | TEXT | |

### `exceptions`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `rule_id` | TEXT FK | |
| `date` | TEXT | One-off cancellation |

Unique on `(rule_id, date)`. Merged with any `EXDATE` present in the RRULE
string.

### `push_subscriptions`

| Column | Type | Notes |
|---|---|---|
| `endpoint` | TEXT PK | |
| `p256dh` / `auth` | TEXT | VAPID key material |
| `created_at` | TEXT | |

---

## 2. The status model

```
                 ┌──────────┐
   materialise ─▶│ pending  │
                 └────┬─────┘
        ┌─────────────┼──────────────┐
        ▼             ▼              ▼
     done          missed        skipped
        ▲                            │
        └──── completing anyway ─────┘
```

| Status | Meaning | Mutable? |
|---|---|---|
| `pending` | Expected, not yet resolved | yes |
| `done` | Completed | **no** |
| `missed` | Expected, not completed, past its close time | **no** |
| `skipped` | Deliberately set aside | **no** |

`pending` is the only mutable state. The three terminal states are frozen — the
generator never rewrites them. The single exception is an explicit user-initiated
reset, which is the only way out of a terminal state.

Two transitions are worth calling out:

- **`pending` → `missed` (the sweep).** Automatic, when the day's close time has
  passed.
- **`skipped` → `done`.** Completing an occurrence inside a skip period. This is
  why working out on holiday counts as a success.

`late` is deliberately **not** a status. It is derived from `completed_at`
versus `due_time` at query time, so the ledger stays at four states.

---

## 3. The two invariants

These are load-bearing. Breaking either silently corrupts user data.

### Invariant 1 — terminal states are frozen

`done`, `missed` and `skipped` are never rewritten by the generator.

Without this, statistics are untrustworthy: if the application can revise what
happened, then the numbers are whatever the code happens to compute this week
rather than a record.

Asserted in `test/generator.test.ts` ("never modifies a terminal occurrence").

### Invariant 2 — nothing exists before `created_date`

No occurrence is materialised before the local civil date on which the rule was
created.

Rationale: you cannot have failed at a commitment you were not yet tracking.
Without this, creating a rule today would immediately materialise a month of
`missed` rows and fire the recovery prompt on a brand-new install.

Backdating is still possible, deliberately, by moving `dtstart_date`.

---

## 4. Why dates are civil dates, not instants

A `scheduled_date` is a `YYYY-MM-DD` string. It carries no time and no offset.

All calendar arithmetic runs on UTC-midnight `Date` objects used purely as an
integer carrier. This makes daylight saving structurally irrelevant: a 23-hour
day and a 25-hour day are indistinguishable, so a DST transition cannot shift an
occurrence by a day.

This is the single most effective correctness decision in the codebase. Date
arithmetic done on wall-clock instants is where most recurring-task
implementations go wrong.

See [ADR 0002](adr/0002-civil-dates-not-utc-instants.md).

---

## 5. When a day closes

An occurrence for date `D` stays open until `D+1` at `day_rollover`, in the
user's timezone.

```
scheduled_date = 2026-09-29
day_rollover   = 04:00
timezone       = Europe/Warsaw

closes at  2026-09-30T02:00:00Z   (04:00 Warsaw)
```

Before that instant it is `pending`. After it, an untouched occurrence is swept
to `missed`.

**Why not local midnight?** Because a task done at 23:00 would then count as a
failure, and every evening habit would show a permanent 100% failure rate. The
rollover is a per-user setting, defaulting to 04:00, precisely so that late
evenings are not punished.

See [ADR 0003](adr/0003-day-rollover.md).

---

## 6. Timezone resolution and DST

Converting a wall-clock time in a named zone to a UTC instant is done by
computing the zone's offset at that instant and iterating to a fixed point:

```ts
const wallClock = Date.UTC(y, m - 1, d, hh, mm);
let offset = timeZoneOffsetMs(new Date(wallClock), timeZone);
let instant = wallClock - offset;
const refined = timeZoneOffsetMs(new Date(instant), timeZone);
if (refined !== offset) instant = wallClock - refined;
```

This resolves both the spring-forward gap, where 02:30 does not exist, and the
fall-back ambiguity, where 02:30 occurs twice. Both are covered by tests, and
both produce a usable instant rather than `NaN`.

---

## 7. Migration policy

Schema changes ship as plain SQL migrations applied in order at startup. There is
no migration framework, because there is one database file and one user.

The rule when changing the schema: **never lose history.** A migration may add
columns, add tables, or backfill, but a migration that drops or rewrites settled
occurrence data requires an ADR and a review.
