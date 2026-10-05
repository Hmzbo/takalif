# ADR 0007 — Data portability: JSON backup, CSV and VTODO export

**Status:** Accepted

---

## Context

Two risks converge on one requirement. The solo-maintainer bus factor (Plan §9)
means the project could stop; the statistics are years of personal history, so
"keep running the server forever" is not a preservation strategy. The data must
outlive the application, in formats other tools can read.

Requirements R7.1–R7.4 ask for full JSON backup and restore, CSV export of the
ledger, CalDAV `VTODO` export with `RRULE`, and import from at least one of the
above.

---

## Decision

**JSON is the canonical complete format, and the only one that imports back.**

The envelope (`BACKUP_VERSION`, currently 1) carries settings, rules, rule
versions, occurrences, skip periods and exceptions. Validation
(`parseBackupDocument`) runs before any row is touched and rejects everything
the interactive routes would reject — bad RRULEs, unknown calendars, dates
before a rule's `created_date` — plus backup-specific hazards: duplicate ids,
duplicate `(rule_id, scheduled_date)` pairs, occurrences pointing at unknown
rule versions.

Restore **replaces** the dataset in a single transaction. It is an explicit,
confirm-gated user action, which is why it may write terminal rows the
generator never would — the same category as excuse and reset, not a breach of
the frozen-history invariant.

Two things deliberately do not round-trip:

- `push_subscriptions` are excluded from backups and survive a restore. Device
  endpoints are not portable data; wiping them would orphan every installed
  client with no way back.
- `reminded_at` resets. It records that *this* server already sent a
  notification, not ledger state.

**CSV is the ledger for spreadsheets — export only.** One row per occurrence
joined with its rule title, RFC 4180 quoting, plus a `'` prefix on fields
starting with `= + - @` (OWASP formula-injection guidance). The default window
is the trailing year; the complete history is the JSON backup, and an unbounded
CSV would be a denial of service on the event loop.

**VTODO is the schedules for other tools — export only.** Each rule becomes a
`VTODO` with a stable `UID:{id}@takalif`, plain-RFC `RRULE`, and `DTSTART`. Our
`CALENDAR=` extension is stripped from the `RRULE` (foreign parsers would choke
on it) and preserved in `X-TAKALIF-CALENDAR`; embedded `EXDATE` parts are
lifted into real `EXDATE` properties. Archived rules export as
`STATUS:CANCELLED`.

---

## Consequences

**Positive**

- A user can leave at any time with everything: history (JSON/CSV) and
  schedules (VTODO/JSON).
- Import is one code path with one validator, tested as golden files in core
  and round-trips in server integration tests.
- Corrupt files fail with a named validation error and write nothing; residual
  storage errors map to a generic 400 that leaks no schema detail.

**Negative — accepted**

- CSV and VTODO do not import. R7.4 is satisfied by JSON, and each additional
  import path is a new validator to maintain against hostile input.
- `createdAt`/`updatedAt` on occurrences and skips default to restore time when
  absent, so export → import → export is not byte-identical. Harmless; nothing
  reads those fields semantically.

---

## Alternatives considered

### Merge/upsert restore instead of replace-all

- **For:** feels safer; cannot delete newer data with an older backup.
- **Against — rejected:** leaves orphan rows for rules deleted since the backup,
  and "merge" of two histories with the same ids but different contents has no
  well-defined answer. Replace-all is atomic and its outcome is exactly the
  file, which is what a backup means.

### Full CalDAV server

- **Against — rejected as out of scope:** serving `REPORT`, sync tokens and
  authentication is a second product. Static VTODO export satisfies "schedules
  survive this project" at a fraction of the surface.

### VTODO or CSV import

- **Against — deferred:** JSON already satisfies R7.4. VTODO import would need
  to map foreign `RRULE` dialects onto versioned rules; CSV import would need
  to rejoin titles to ids. Both are real work with hostile-input validators,
  unjustified while JSON covers the need.
