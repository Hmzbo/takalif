# Statistics

The formulas, and why they are defined the way they are.

---

## 1. Counting

For a date range and an optional rule filter, count occurrences:

```
done     = status = 'done'
missed   = status = 'missed'
skipped  = status = 'skipped'
pending  = status = 'pending'

elapsed  = done + missed + skipped
total    = elapsed + pending
```

`pending` is excluded from `elapsed` because a day that has not closed yet cannot
be scored. This matters: without it, a month in progress would show adherence
falling through the month simply because days had not elapsed.

---

## 2. Adherence

```
adherence = done / (done + missed)
```

Three decisions, each deliberate:

### Skipped is excluded from the denominator

A holiday should not count as failure. Excluding `skipped` means a two-week
vacation does not drag a month's adherence down.

### `done` outranks `skipped`

If you complete an occurrence that was skipped — training while away — it is
promoted to `done` and counts as a success. This falls out of the status
ordering with no special-casing: `done` simply replaces `skipped`.

### `null` when nothing has elapsed

With no elapsed occurrences, adherence is `null`, and the UI renders an em dash.

Never render `0%` in that case. A brand-new rule showing 0% looks like failure,
and the number is meaningless. Reporting `null` forces the interface to be
honest about the absence of data.

---

## 3. The skipped count is always shown

```
20 / 30 · 8 skipped
```

This is not decoration. Hiding the skipped count would make "skip everything"
indistinguishable from a perfect month.

The skipped count is the guard against gaming the metric, and it is the reason
the user can trust the adherence number they are looking at.

---

## 4. Worked example

`Workout`, `FREQ=DAILY`, September 2026.

The user trained on 18 ordinary days, marked a two-day holiday, and trained on
both of those days anyway, and missed 10.

| | |
|---|---|
| Ordinary completions | 18 |
| Holiday completions promoted to `done` | 2 |
| **`done`** | **20** |
| `missed` | 10 |
| `skipped` remaining | 0 |
| `pending` | 0 (September is closed) |

```
adherence = 20 / (20 + 10) = 66.7%
```

Note that the vacation days vanished from the denominator *and* the two workouts
counted as successes. Both behaviours come from the same two rules, and neither
required special-casing in the code.

---

## 5. Lateness

Only for rules with a `due_time`.

```
late    = done AND due_time IS NOT NULL AND completed_at > scheduled_date @ due_time
lateRate = late / done
```

Derived at query time, never stored as a status. This keeps the ledger at four
states and means a change to a due time does not require rewriting history.

---

## 6. Behind

```
behind.last7  = count of missed with scheduled_date within the last 7 days
behind.last30 = count of missed with scheduled_date within the last 30 days
```

This is the "you are three days behind" figure. It answers a different question
from adherence: not *how good* you were, but *how far behind you are right now*.

---

## 7. Trend

Adherence bucketed by month, for a sparkline.

Months with no elapsed occurrences report `null`, not `0%`, so a gap in the trend
line reads as a gap rather than as a disaster.

---

## 8. Streaks

Opt-in per rule, off by default.

Walk the elapsed occurrences newest-first:

| Status | Effect |
|---|---|
| `done` | extends the run |
| `missed` | breaks the run |
| `skipped` | **neutral** — neither extends nor breaks |
| `pending` | not terminal; skipped over |

Three figures are produced:

- **current** — the newest run
- **best** — the longest run ever
- **longestRunStart** — the chronologically earliest date of the best run

### Why skipped is neutral

Two defensible choices:

- *breaks* — the simplest implementation, but a holiday would destroy a streak,
  which is exactly the demotivation that habit trackers are criticised for.
- *extends* — a holiday would inflate a streak, which is dishonest.

Neutral is correct, and it is only correct because `skipped` is a distinct state
with its own semantics rather than an absence of data.

---

## 9. Report shape

```ts
interface PeriodReport {
  from: LocalDate;
  to: LocalDate;
  overall: AdherenceSummary;
  trend: TrendPoint[];
  perRule: RuleBreakdown[];
}
```

`overall` covers the whole period; `perRule` gives a summary and an optional
streak per rule. Rules with no activity in the period are omitted rather than
shown as `null` rows, so the list stays readable as it grows.
