# Requirements

## 1. Functional requirements

### 1.1 Rules (schedules)

- **R1.1** The user can create a rule with a title, an optional description, an
  RFC 5545 RRULE, a start date, an optional due time, and a calendar.
- **R1.2** The user can edit a rule. An edit that changes the schedule opens a
  new version; it never rewrites existing settled occurrences.
- **R1.3** The user can preview what a schedule change would do before applying
  it — which pending occurrences would be added or withdrawn.
- **R1.4** The user can archive a rule. Archived rules keep their history and
  remain queryable in reports.
- **R1.5** A rule can carry an optional due time (`HH:MM`), which makes lateness
  measurable.
- **R1.6** A rule can opt in to streak tracking. Streaks are off by default.
- **R1.7** A rule's RRULE is validated at creation time. An invalid RRULE is
  rejected rather than silently producing no occurrences.

### 1.2 Occurrences

- **R2.1** The application materialises expected occurrences for every active
  rule over a bounded window around today.
- **R2.2** The user can mark an occurrence done, missed, or skipped, reassign
  it between those while its day is still open, or reset a settled
  occurrence back to pending.
- **R2.3** An occurrence can carry a note.
- **R2.4** Settled occurrences (`done`, `missed`, `skipped`) are never modified
  automatically. Explicit user actions may reassign them while the day is
  open; after it closes only excusing a `missed` day remains.
- **R2.5** A day stays open until a configurable rollover time on the following
  day, so work done late in the evening is not recorded as failure.
- **R2.6** Occurrences whose day has already closed are materialised directly as
  `missed` rather than `pending`, so widening the lookback window never leaves a
  backlog of stale rows.

### 1.3 Skip periods

- **R3.1** The user can define an inclusive date range as a skip period — a
  holiday, illness, or any other span that should not count against adherence.
- **R3.2** Occurrences inside a skip period are materialised as `skipped`, not
  `missed`.
- **R3.3** `skipped` is excluded from the adherence denominator.
- **R3.4** Completing an occurrence inside a skip period promotes it to `done`,
  and it counts as a success.
- **R3.5** The skipped count is always displayed alongside adherence, so the
  denominator is never hidden.

### 1.4 Statistics

- **R4.1** Adherence percentage is the primary metric, computed per rule and
  overall, over week, month, quarter, year, or an arbitrary range.
- **R4.2** Failure counts are always available and displayed secondary to
  adherence.
- **R4.3** Lateness is derivable for rules with a due time.
- **R4.4** "Behind" is reported over trailing 7-day and 30-day windows.
- **R4.5** Adherence trend is available bucketed by month for sparkline display.
- **R4.6** Streaks are computed per rule when opted in, reporting the current
  streak, the best streak, and the date the best run began.
- **R4.7** With nothing elapsed, adherence is reported as `null`, rendered as an
  em dash — never as `0%`.

### 1.5 Calendars

- **R5.1** The calendar is a per-rule property. Gregorian and Hijri rules can be
  in use simultaneously.
- **R5.2** A user-level default calendar is a display preference and the default
  for new rules; it does not constrain what a rule can be.
- **R5.3** Dates can be rendered in either calendar.
- **R5.4** Month- and day-anchored rules (`BYMONTH`, `BYMONTHDAY`, `BYSETPOS`)
  are interpreted in the rule's own calendar.
- **R5.5** Hijri month lengths vary (29 or 30 days). An anchor on a day that does
  not exist in a given month is skipped, not clamped.
- **R5.6** The client renders correctly under right-to-left layout.

### 1.6 Recovery

- **R6.1** When the number of occurrences swept in a single pass exceeds a
  threshold, the API surfaces a recovery prompt offering to mark them all
  missed, skip them, or review them individually.

### 1.7 Interoperability

- **R7.1** Full JSON backup and restore.
- **R7.2** CSV export of the occurrence ledger.
- **R7.3** CalDAV `VTODO` export with `RRULE`, so schedules survive this project.
- **R7.4** Import from at least one of the above.

### 1.8 Reminders

- **R8.1** Web Push notifications for due occurrences.
- **R8.2** Reminders are scheduled server-side, so they fire without the client
  being open.
- **R8.3** An ntfy fallback exists because desktop push requires the browser to
  be running. Email remains a listed destination for a later fallback.

### 1.9 Pairing and companion access

- **R9.1** API calls from off the machine require a pairing bearer token on
  every route except `/api/health`. Loopback callers never need it.
- **R9.2** A loopback-only pairing endpoint reports the machine's LAN address
  and the token, for the companion's QR setup. It never answers off-machine.
- **R9.3** The token comes from `TAKALIF_TOKEN` or a persisted file beside the
  database, so pairing survives restarts.
- **R9.4** A loopback-only rotation endpoint replaces the code on demand;
  previously issued codes stop working at once. Rotation is refused while the
  token is pinned by `TAKALIF_TOKEN`, which would otherwise resurrect the old
  code on the next boot.

---

## 2. Non-functional requirements

- **NF1. Correctness of history above convenience.** No change may reinterpret a
  settled occurrence.
- **NF2. Determinism.** Given the same input and clock, the generator produces
  the same plan. Output must not depend on the host machine's timezone.
- **NF3. Idempotency.** Running the generator twice over unchanged state
  performs no work.
- **NF4. Fault isolation.** One malformed rule must not prevent the rest of the
  ledger from being materialised.
- **NF5. Single-user.** No authentication, no user table. Designed for a person
  running their own instance. API access from off the machine additionally
  requires the pairing bearer token; loopback stays open.
- **NF6. Trivial installation.** One installer (desktop app), one
  `docker compose up`, or from source; SQLite only; no external services
  required.
- **NF7. Testability.** The domain core is pure — no I/O, no framework — so that
  the generator and statistics are testable exhaustively without a database.
- **NF8. No fabricated history.** Nothing is materialised before the date a rule
  was created.
- **NF9. Privacy.** All data lives on the user's own server. No telemetry.

---

## 3. Out of scope

Explicitly, so that these are not re-litigated in every review:

- One-time tasks, meetings, calendar events
- Quota-style schedules ("3x per week")
- Multi-user, households, sharing
- Gamification, badges, default streaks
- Time tracking
- Notes or journaling
- Subtasks, priorities as scheduling, dependencies between tasks
