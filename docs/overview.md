# Overview

MyWeeklies tracks **recurring commitments** and measures **how faithfully you kept
them over time**.

It answers questions that other categories of software cannot:

- How consistently did I keep up with a daily commitment this month?
- Which commitments do I drop most often?
- How far behind am I on something that is supposed to happen weekly?
- Am I actually improving, or just telling myself I am?

---

## The two objects

Everything in the model rests on separating two things that most applications
conflate.

### The rule

A *rule* is a schedule: "Workout, every day", "Rent, the 1st of every month",
"Fast, Mondays and Fridays", "Club night, every second Tuesday".

A rule is stored as an [RFC 5545 RRULE](https://datatracker.ietf.org/doc/html/rfc5545#section-3.3.10)
value. It describes *what should happen*, and it can be edited, archived, or
superseded. It never describes what actually happened.

### The ledger

A *ledger* is the record of every occurrence the rule called for, each one
carrying a final state:

| Status | Meaning |
|---|---|
| `pending` | Expected, not yet resolved |
| `done` | Completed |
| `missed` | Expected, not completed, and now past its close time |
| `skipped` | Deliberately set aside, e.g. a holiday |

The ledger is the product. Checking a box is trivial; knowing that 24 things were
*expected* in a month, and that 18 of them were completed, is the part that no
other tool provides.

---

## Why existing tools do not do this

### To-do applications

Most recurring-task apps model recurrence as *"clone the next occurrence when you
mark this one done"*, or as *"one task with a rolling due date"*. Either way the
past is destroyed. Once an occurrence is completed, the task advances; there is no
record that it existed.

You cannot compute compliance over data that no longer exists.

This is not a peripheral limitation. As of September 2026, the leading
open-source to-do app still has an open feature request and an open pull request
for recurring-task history that dates back to 2022.

### Habit trackers

Habit trackers do keep history, and they produce good-looking analytics:
completion rates, streaks, heatmaps. But their scheduling model is a **quota**,
not a calendar:

- "3 times per week"
- "X times in Y days"
- "an interval since last completion"

A quota cannot express "every second Tuesday", "the last Friday of the month", or
"the 13th of every month in the Hijri calendar". And because the quota is
interpreted relative to *now*, editing it silently rewrites the past: loosen a
rule from daily to weekly, and the historical completion rate recomputes upward.
The data becomes a lie, and an undetectable one.

### The gap

Neither category can answer the question, because neither can represent both a
calendar-anchored schedule *and* a durable record of what was expected.

MyWeeklies holds both at once.

---

## Goals

1. **Be correct about the past.** Statistics must never be reinterpreted after the
   fact. See the [data model invariants](data-model.md).
2. **Be honest with the user.** Adherence is reported plainly, including
   failures, but failures are never the headline. The skipped count is always
   visible so no number can be read as better than it is.
3. **Be genuinely easy to install.** One command, one SQLite file, no account.
4. **Be usable by a person who does not use the Gregorian calendar as their
   primary one.** See [calendars](calendars.md).
5. **Interoperate.** CalDAV `VTODO` with `RRULE`, plus JSON and CSV export. Your
   history must outlive this project.

## Non-goals

Deliberate and load-bearing. Keeping the scope narrow is what makes the data model
possible.

- **Not a calendar.** No meetings, no events, no one-time tasks.
- **Not a quota system.** "3x per week" is not a schedule and is unsupported.
- **Not multi-user.** No auth, no accounts, no sharing.
- **Not a time tracker.** We do not measure duration.
- **Not gamified.** No badges, no XP, no default streaks.
- **Not a notes app.**
