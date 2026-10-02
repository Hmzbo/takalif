# ADR 0002 — Civil dates, not UTC instants

**Status:** Accepted

---

## Context

Occurrences must be identified by *day*. Which day, and how is it represented?

The obvious choice — a UTC timestamp, or an ISO 8601 datetime — is also the wrong
one, because it conflates two different things: a calendar date, and a point in
time.

---

## Decision

A `LocalDate` is a `YYYY-MM-DD` string. It carries **no time and no offset**.

All calendar arithmetic runs on UTC-midnight `Date` objects used purely as an
integer carrier. The user's timezone enters only where a real wall-clock question
is being asked — "what is today?", "has this day's bucket closed?".

---

## Consequences

**Positive — daylight saving becomes structurally irrelevant.**

A 23-hour day and a 25-hour day are indistinguishable, because arithmetic is
performed on calendar dates rather than elapsed time. A DST transition cannot
shift an occurrence by a day.

This is the single most effective correctness decision in the codebase. Date
arithmetic performed on wall-clock instants is where most recurring-task
implementations go wrong.

**Positive — timezone invariance.**

Given the same configured timezone, the generator's output does not depend on the
host machine's zone. Asserted by test.

**Negative**

- Mixing `LocalDate` with `Date` requires deliberate conversion. The boundary is
  narrow and contained in `dates.ts`, but it must be respected.

---

## Alternatives considered

### UTC instants

Storing `2026-09-30T00:00:00Z` for a "day" is wrong on its own terms: midnight
UTC is not midnight anywhere for most users, so the day bucket is arbitrary.

### Wall-clock instants in the user's zone

Correct at a point in time, but arithmetic becomes DST-sensitive: adding 24 hours
across a spring-forward boundary lands on the wrong calendar day. This is the bug
that makes "add a day" unreliable.

---

## Related

Multi-calendar support ([ADR 0005](0005-multi-calendar-support.md)) rests on this.
A single absolute day has both a Gregorian and a Hijri representation, so adding a
calendar is a rendering and anchoring concern rather than a change to the ledger.
