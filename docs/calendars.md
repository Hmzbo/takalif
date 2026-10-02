# Recurrence and calendars

How schedules are expressed, expanded, and how the Gregorian and Hijri calendars
coexist.

---

## 1. RRULE

Schedules are [RFC 5545 RRULE](https://datatracker.ietf.org/doc/html/rfc5545#section-3.3.10)
values. A bare value, with `DTSTART` supplied separately as a civil date:

```
FREQ=DAILY
FREQ=DAILY;INTERVAL=15
FREQ=WEEKLY;BYDAY=MO,FR
FREQ=WEEKLY;BYDAY=TU;INTERVAL=2
FREQ=MONTHLY;BYMONTHDAY=1
FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1
FREQ=MONTHLY;BYMONTHDAY=13,14,15;CALENDAR=ISLAMIC-UMALQURA
```

Validation happens at rule creation. A malformed RRULE is rejected immediately —
never accepted and then quietly produce nothing.

---

## 2. Expansion

`expandRRule` in `core/src/rrule.ts` expands a rule over an inclusive date range
and returns civil dates.

```ts
type RRuleExpander = (options: {
  rrule: string; dtstart: LocalDate; from: LocalDate; to: LocalDate;
}) => LocalDate[];
```

All dates are handled as UTC-midnight carriers, so a daylight-saving transition
cannot shift an occurrence by a day.

### Correct month-end behaviour

`FREQ=MONTHLY;BYMONTHDAY=31` **skips** months that have no 31st. February is not
clamped to the 28th.

This is the classic RRULE trap, and it is covered by a golden test.

### The seam

`expandRRule` is the only place that imports an RRULE library. Swapping
implementations is a one-file change, and the generator is testable without
depending on library behaviour.

---

## 3. Multiple calendars

The calendar is a **per-rule property**, not a global setting.

A user tracks a tennis session every 15 days on the Gregorian calendar and a fast
on the 13th, 14th and 15th of every Hijri month, at the same time. Neither
contaminates the other.

- `rules.calendar` is an enum: `GREGORIAN` (default) or an Islamic variant.
- `settings.default_calendar` is a display preference and the default for newly
  created rules. It does **not** constrain what a rule can be.

### The day sequence is calendar-agnostic

This is the key insight, and it is why multi-calendar support is cheap.

Internally, occurrences remain keyed by Gregorian civil date, which is already a
1:1 encoding of an absolute day. Calendars affect only two things:

1. how a rule's month and day anchors are interpreted;
2. how a date is rendered for the user.

Consequence: **the ledger, the generator and the statistics do not change.** A
single absolute day has both a Gregorian and a Hijri representation; which one is
displayed is a rendering concern.

### Which parts of an RRULE are calendar-sensitive

| Component | Sensitive? | Reason |
|---|---|---|
| `BYMONTHDAY` | **yes** | "The 13th" means 13 Rabi' al-Awwal, not a Gregorian 13th |
| `BYSETPOS` with `BYDAY` | **yes** | "Last Friday" means the last Friday of the Hijri month |
| `BYDAY` alone | no | Day names are shared vocabulary; "Monday and Friday" is unambiguous |
| `FREQ=DAILY` / `INTERVAL` | no | Days are days; the calendar is only a naming scheme |

Note on `BYDAY`: the first day of the week differs by region — Sunday in much of
the Gulf, Saturday elsewhere. Since we anchor by absolute weekday, this affects
only the display of week boundaries, not which days match.

### Hijri month lengths

Islamic months are 29 or 30 days. Verified for 1448 AH:

```
ummalqura:  29 30 29 30 30 29 30 30 29 30 29 30   = 355
civil:      30 29 30 29 30 29 30 29 30 29 30 29   = 354
```

So `BYMONTHDAY=30` skips the 29-day months — exactly the behaviour
`BYMONTHDAY=31` already has in Gregorian. **One code path, tested twice.**

---

## 4. Hijri date conversion

### No dependency

Node 22 and every target browser ship full ICU, which includes the Islamic
calendars. There is no date library to vendor.

| Variant | ICU tag | 2026-10-02 |
|---|---|---|
| Umm al-Qura | `islamic-umalqura` | 4/21/1448 AH |
| Civil (arithmetic) | `islamic-civil` | 4/19/1448 AH |
| Tabular | `islamic-tbla` | 4/20/1448 AH |
| Persian Gulf Standard | `islamic-rgsa` | 4/21/1448 AH |

Formatting works continuously from 2020 to at least 2400.

### Inversion

Recurrence needs the other direction: given a Hijri month and day, find the
Gregorian civil dates.

`Intl` does not provide this, so it is done by binary search over a ±400-day
bracket seeded from the arithmetic mean solar year:

```ts
const seed = Date.UTC(2026, 0, 1) + (hy - 1447) * 354.367 * DAY;
let lo = seed - 400 * DAY;
let hi = seed + 400 * DAY;
while (lo < hi) {
  const mid = Math.floor((lo + hi) / 2 / DAY) * DAY;
  const h = toHijri(new Date(mid));
  const cmp = h.y - hy || h.m - hm || h.d - hd;
  if (cmp < 0) lo = mid + DAY; else hi = mid;
}
```

**Verified exhaustively:** round-tripping every day across two Gregorian years
gives 730/730 correct, 0 failures, on both Umm al-Qura and civil.

Verified against the real use case — 13/14/15 of the first three months of
1448 AH:

```
2026-06-28  2026-06-29  2026-06-30
2026-07-27  2026-07-28  2026-07-29
2026-08-26  2026-08-27  2026-08-28
```

Nonexistent days (day 30 of a 29-day month) must be skipped, never clamped.

---

## 5. Which Islamic variant

**Not decided.** This is a product decision for the intended users, not a
technical one, and it is more consequential than it looks.

| Option | Behaviour | Trade-off |
|---|---|---|
| **Umm al-Qura** | Official in Saudi Arabia, followed widely | A published *table*, periodically corrected. Cannot be computed arbitrarily far ahead. |
| **Civil** | Pure arithmetic algorithm | Stable and computable forever, but differs from Umm al-Qura by roughly a day, and many users will notice. |
| **Observational** | What people actually do | Cannot be predicted in advance, so it cannot drive a recurrence engine at all. |

The honest options are Umm al-Qura or civil as the default, with the other
selectable.

A more ambitious option: keep the *schedule* in a calculated calendar while
letting the user confirm or correct each occurrence against what they actually
observed. That reconciles predictability with practice, at the cost of more
complexity in the ledger.

Current recommendation: **Umm al-Qura default, civil selectable, observational
supported as manual confirmation only.**

---

## 6. Fasting days begin at sunset

In Islamic practice a fasting day runs from **Maghrib (sunset) on the previous
day** to **Fajr (dawn)**. "Fast the 13th" *starts* at sunset on the 12th.

This interacts with the day rollover. The existing rollover already models "when
does a day close", and the correct behaviour for a fasting rule is to shift the
day's boundary by the sunset time for that date and location.

Doing it properly needs sunset times, which means a location lookup or a
user-provided coordinate.

**Deferred**, but recorded so it is not lost. Until then a fasting rule behaves
like any other rule with a `due_time`.

---

## 7. Right-to-left layout

Arabic is read right-to-left, so the client must lay out correctly under
`dir="rtl"`.

Using CSS logical properties (`margin-inline-start`, `inset-inline-end`) rather
than physical ones (`margin-left`) makes this mostly free — but only if it is
done from the start. Retrofitting RTL into a stylesheet written with physical
properties is expensive, which is why it is recorded here.
