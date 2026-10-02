# ADR 0005 — Per-rule calendars: Gregorian and Hijri

**Status:** Accepted

---

## Context

Commitments in the Islamic calendar — Ramadan, and the recurring fasts on the
13th, 14th and 15th of every Hijri month — cannot be expressed in a Gregorian
RRULE. Hijri months are 29 or 30 days and drift relative to the solar year, so
"the 13th of every month" has no fixed Gregorian anchor.

A global calendar preference is not enough either. A person may reasonably track a
tennis session every 15 days *and* a Hijri-monthly fast, at the same time.

---

## Decision

**The calendar is a property of the rule, not of the user.**

- `rules.calendar` is a per-rule enum: `GREGORIAN` (default) or an Islamic
  variant.
- `settings.default_calendar` is a display preference and the default for new
  rules. It does **not** constrain what a rule can be.

### The day sequence is calendar-agnostic

Internally, occurrences remain keyed by Gregorian civil date, which is already a
1:1 encoding of an absolute day. Calendars affect only:

1. how a rule's `BYMONTH` / `BYMONTHDAY` / `BYSETPOS` anchors are interpreted;
2. how a date is rendered.

**The ledger, generator and statistics do not change.** This is the payoff for
[ADR 0002](0002-civil-dates-not-utc-instants.md).

### RRULE extension

A `CALENDAR=` qualifier is accepted:

```
FREQ=MONTHLY;BYMONTHDAY=13,14,15;CALENDAR=ISLAMIC-UMALQURA
```

`expandRRule` interprets month- and day-anchored rules in the named calendar and
converts each target day back to a Gregorian civil date.

---

## Consequences

**Positive**

- Gregorian and Hijri commitments coexist naturally.
- No change to the ledger or the statistics.
- No new dependency: `Intl` in Node and browsers carries all the Islamic
  variants, with formatting verified continuously from 2020 to at least 2400.
- Hijri month-end behaviour reuses the existing rule: day 30 skips 29-day months,
  exactly as day 31 skips February.

**Negative**

- Hijri→Gregorian inversion is not provided by `Intl` and must be implemented by
  binary search. Verified exhaustively at 730/730 round-trips across two Gregorian
  years on both Umm al-Qura and civil.
- The variant choice is a product question, not a technical one, and it has real
  consequences for credibility. See below.

---

## Alternatives considered

### A global calendar setting

Rejected: cannot represent a user who tracks both.

### A separate ledger per calendar

Rejected: duplicates the statistics machinery and makes cross-calendar reporting
meaningless.

### A third-party date library

Rejected: `Intl` already provides the calendars, and a library would add a
dependency that must be kept in sync across server and browser.

---

## Open: which Islamic variant is the default

**Not decided.** This is a question for the intended users, not for the
implementer.

| Option | Behaviour | Trade-off |
|---|---|---|
| **Umm al-Qura** | Official in Saudi Arabia, followed widely | A published *table*, periodically corrected; cannot be computed arbitrarily far ahead |
| **Civil** | Pure arithmetic | Stable forever, but differs from Umm al-Qura by roughly a day, which users will notice |
| **Observational** | What people actually do | Cannot be predicted, so it cannot drive a recurrence engine |

Current recommendation: **Umm al-Qura default, civil selectable, observational
supported as manual confirmation only.**

---

## Deferred: fasting days begin at sunset

In Islamic practice a fasting day runs from **Maghrib on the previous day** to
**Fajr**. "Fast the 13th" *starts* at sunset on the 12th.

Modelling this correctly means shifting a rule's day boundary by the sunset time
for that date and location, which needs a location lookup or a user-supplied
coordinate.

Deferred deliberately. Until then a fasting rule behaves like any other rule with
a `due_time`.

---

## Also required

Right-to-left layout. Arabic is read RTL, so the client must render correctly
under `dir="rtl"`. Using CSS logical properties rather than physical ones makes
this mostly free — but only if adopted from the start.
