# Features

Detailed, behaviour-level descriptions. For the reasoning behind each, see the
[architecture decisions](adr/index.md).

---

## 1. Scheduling

### Creating a rule

A rule needs a title and an RRULE. Everything else is optional.

```
title       Workout
rrule       FREQ=DAILY
dtstart     2026-01-01
calendar    GREGORIAN
```

```
title       Rent
rrule       FREQ=MONTHLY;BYMONTHDAY=1
due_time    09:00
```

```
title       Club night
rrule       FREQ=WEEKLY;BYDAY=TU;INTERVAL=2
```

```
title       Tennis
rrule       FREQ=DAILY;INTERVAL=15
```

```
title       Fast
rrule       FREQ=MONTHLY;BYMONTHDAY=13,14,15;CALENDAR=ISLAMIC-UMALQURA
```

```
title       Fast Mondays and Fridays
rrule       FREQ=WEEKLY;BYDAY=MO,FR
```

The RRULE is validated at creation. A malformed one is rejected immediately —
never accepted and then quietly produce nothing.

### Editing a rule

Editing opens a new *version* with an `effective_from` date. Settled occurrences
keep pointing at the version that produced them, so history is never
reinterpreted.

**Edit preview.** Before applying, the client can ask what a change would do:

```
GET /api/rules/:id/edit-preview?rrule=FREQ=WEEKLY;BYDAY=MO&effectiveFrom=2026-10-01
```

returns the pending occurrences that the new schedule would add or withdraw, so
the user can see the effect before it happens.

### Archiving

Archiving is a soft delete. The rule stops generating, and its history remains
fully queryable — which matters, because reports that silently lose archived
rules are reports you cannot trust.

---

## 2. The day view

The primary screen. Everything due on a date, one tap to complete.

```
Today · Friday 2 October 2026
                                    1448 AH · 4/21

  ○ Workout                              daily
  ● Rent                                 1st of the month
  ○ Fast                                 13/14/15 of the month
  ○ Club night                           every 2nd Tuesday
```

Completed items are visible in place rather than hidden, so the day reads as a
record rather than a queue that empties.

Each occurrence can carry a short note — "gym instead", "felt strong" — set
from the day view. Notes are annotation, not ledger state: they change no
adherence figure and survive every materialisation.

---

## 3. Skipping and holidays

Marking a date range as away is one action, not one per occurrence.

```
Skip period: 2026-08-01 → 2026-08-21   reason: Summer holiday
```

Three behaviours follow, none requiring special-casing:

1. Occurrences in the range are materialised `skipped`, never `missed`.
2. They leave the adherence denominator entirely.
3. If you complete one anyway, it is promoted to `done` and counts as a success.

The skipped count is always shown next to the result:

```
20 / 30 · 8 skipped
```

This is deliberate. Hiding skips would make "skip everything" indistinguishable
from a perfect month, and a number you cannot trust is worse than a number you
dislike.

Ranges are managed in Settings → Time away, where they can be added ahead of a
trip and removed afterwards. Removing a range never rewrites settled rows.

---

## 4. Statistics

### Headline

```
September 2026                     adherence 66.7%
Workout      20 / 30          10 missed · 2 skipped
Rent         1 / 1            0 missed
```

### What is available

| Figure | Definition |
|---|---|
| Adherence | `done / (done + missed)` |
| Failure count | number of `missed` |
| Skip rate | `skipped / elapsed` |
| Lateness rate | `late / done`, for rules with a due time |
| Behind (7d / 30d) | misses in the trailing window |
| Trend | adherence per month |
| Streak | current, best, and best-run start (opt-in per rule) |

Full formulas and worked examples: [statistics.md](statistics.md).

### Recovery prompt

Return after a long absence and the app asks, rather than silently recording a
wall of failures:

```
21 unlogged occurrences · 1 Aug – 21 Aug

  [ Mark all missed ]  [ I'm away, skip these ]  [ Review individually ]
```

---

## 5. Reminders

- Scheduled server-side, so they fire whether or not the client is open.
- Per-rule reminder time. Only today's pending occurrences qualify, and each
  is reminded at most once.
- Delivered by Web Push to installed PWAs (needs `VAPID_*` env vars).
- ntfy fallback: set a topic and reminders arrive there too, with no account
  and no per-device setup.
- Email remains a listed destination for a later fallback.

---

## 6. Data you can take with you

- **JSON** — complete backup and restore.
- **CSV** — the occurrence ledger, for spreadsheets or analysis.
- **CalDAV `VTODO`** — schedules with their `RRULE`, so another tool can pick up
  where this one leaves off.

The schema is documented, so the data is never hostage to the application.
