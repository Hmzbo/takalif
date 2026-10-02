# Takalif

Track recurring commitments, and see how faithfully you actually kept them.

Most habit trackers ask "did you do the thing today?" and give you a streak.
Most to-do apps ask "what did you plan?" and then forget the answer. Neither one
can tell you how often you kept a promise you made to yourself in February.

Takalif is a small, self-hosted app for **recurring commitments** — daily,
weekly, monthly — and the **adherence record** you build up over time.

```
September 2026 · 20 / 30        66.7% adherence
10 missed · 2 skipped
```

---

## What makes it different

Most recurring-task apps model recurrence as *"clone the next occurrence when
you mark this one done"*, which means the past does not exist. You cannot
compute compliance over data that no longer exists.

Most habit trackers solve the opposite problem — they do have history — but their
schedules are **quotas** ("3x per week"), not **calendars**. A quota cannot
express "every second Tuesday" or "the last Friday of the month", and because
everything is bucketed into day cells, "did I do the monthly review on time?"
collapses into "was the September box green?"

Takalif keeps the two things separate:

- **The rule** — real recurrence, RFC 5545 RRULE. Every second Tuesday, the 1st
  of the month, weekdays only, the last Friday.
- **The ledger** — every *expected* occurrence, recorded, kept for years.

Because the expected set is real data rather than a guess reconstructed from what
you happened to log, the statistics are actually correct.

### And editing a schedule does not rewrite your history

Loosen "Workout" from daily to three times a week, and your past adherence stays
exactly where it was. Schedules are versioned; settled rows keep pointing at the
version that produced them.

This is not a detail most apps get right — it is structurally impossible for
them to get right, because their data model cannot express it.

---

## Features

- **Real recurrence.** Full RRULE support: `BYDAY`, `BYSETPOS`, `INTERVAL`,
  `BYMONTHDAY`, `EXDATE`. Month-end handled correctly — "the 31st" is skipped in
  February, not silently clamped to the 28th.
- **Adherence over time.** Weekly, monthly, quarterly, yearly. Failures are
  always shown; they are never the headline.
- **Honest holidays.** Mark a date range as away. Those days leave the
  denominator — but if you train anyway, it still counts as a success.
- **Streaks, if you want them.** Opt-in per rule, off by default.
- **No backlog graveyard.** Come back after three weeks and you get a prompt
  offering to mark the gap missed or skipped, rather than a wall of silent
  failures.
- **Evening-friendly.** A day closes at a configurable rollover time (default
  4:00 AM), so a task done at 11 PM is not a failure.
- **Timezone-correct.** Your timezone is stored server-side, so your phone and
  your laptop always agree on what "today" is.
- **PWA.** One codebase, installs on Android, Windows and Linux, works offline.
- **Export your data.** JSON and CSV, plus CalDAV `VTODO` interoperability, so
  your history outlives this app.

---

## Quick start

### Docker

```bash
git clone https://github.com/Hmzbo/takalif.git
cd takalif
docker compose up -d
```

Open <http://localhost:8787>.

### From source

Requires Node 22+ and pnpm.

```bash
pnpm install
pnpm --filter @takalif/server start
```

The database is a single SQLite file. There is nothing else to configure, and no
account to create.

### Using it on your phone

Open the server's URL in Chrome and choose **Install app** (or **Add to Home
screen**). It appears in your app drawer and launches fullscreen with no browser
chrome. On desktop, Chrome and Edge both offer **Install this site as an app**,
which adds a Start Menu entry.

For access from your phone while on the same network, set `HOST=0.0.0.0` and
reach the machine by LAN address. For access from anywhere, put it behind Tailscale
or any reverse proxy you already trust.

---

## Configuration

Everything is optional; the defaults work.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address. Set `0.0.0.0` to expose on your network |
| `DB_FILE` | `./data/takalif.sqlite` | SQLite database location |
| `WEB_DIST` | `./packages/web/dist` | Built PWA to serve, when present |

The server is single-user by design: no accounts, no user table. If you expose it
beyond your own machine, put it behind a reverse proxy that handles
authentication.

---

## How adherence is calculated

```
adherence = done / (done + missed)
```

- **Skipped days are excluded from the denominator.** A holiday should not count
  as failure.
- **Completing a skipped day still counts as a success.** Train on your holiday
  and it moves to `done`.
- **Pending days are excluded**, so an unfinished day never counts against you.
- With nothing elapsed, adherence is reported as `—`, never `0%`.

Streaks, when enabled for a rule: `done` extends the run, `missed` breaks it,
`skipped` is neutral, and pending days are not yet terminal.

---

## Project status

Early and in active development. The domain core — the occurrence ledger,
recurrence generator and statistics — is complete and well tested. The HTTP API
is in progress. The web client has not started.

Built as a personal tool first, released openly in the hope it is useful to
someone else.

---

## Documentation

Full technical documentation for engineers, including the architecture, the data
model, and the reasoning behind each decision:

- [`docs/overview.md`](docs/overview.md) — the idea, and what it deliberately is not
- [`docs/requirements.md`](docs/requirements.md) — functional and non-functional requirements
- [`docs/features.md`](docs/features.md) — feature-level behaviour
- [`docs/architecture.md`](docs/architecture.md) — the system and the client/server split
- [`docs/data-model.md`](docs/data-model.md) — schema and the invariants that protect your data
- [`docs/statistics.md`](docs/statistics.md) — the adherence formulas, worked through
- [`docs/calendars.md`](docs/calendars.md) — recurrence and Gregorian + Hijri support
- [`docs/adr/`](docs/adr/index.md) — architecture decision records

---

## Contributing

Contributions are genuinely welcome, including from people who have never
contributed to an open source project before. Issues describing a recurrence
edge case you hit, or a way the statistics confused you, are as valuable as
patches.

**Read [`Agents.md`](Agents.md) first.** It covers the architecture, the domain
invariants that protect your data, and the git workflow. The
[architecture decision records](docs/adr/index.md) explain why the design is what
it is.

### Git workflow, in short

`main` is protected. Never commit or push to it directly.

```bash
git checkout main && git pull --ff-only
git checkout -b fix/core/some-descriptive-name
# ... work, test, commit ...
git push -u origin fix/core/some-descriptive-name
```

Then open a pull request targeting `main`. Branch names are
`<type>/<description>`, where type is `feat`, `fix`, `refactor`, `test`,
`docs`, `build`, `ci` or `chore`. Namespace with the package when the change is
scoped to one, e.g. `fix/server/occurrence-reset`.

Commits follow Conventional Commits: `fix(core): freeze skipped occurrences`.

### Running the tests

```bash
pnpm install
pnpm test
pnpm typecheck
```

### What helps most right now

- **Recurrence edge cases.** If you find a schedule the app gets wrong — a
  daylight-saving boundary, a month-end, an unusual `BYDAY`/`BYSETPOS` combo —
  that is a genuinely valuable bug report.
- **Portability.** Running on Linux, macOS, or ARM. Only Windows/x64 has been
  exercised so far.
- **Accessibility and mobile layout** of the web client, once it exists.

### What will not be accepted

Takalif is deliberately narrow, and keeping it narrow is what makes it
useful:

- One-off tasks, meetings, or calendar events. This is not a calendar.
- Quota-style schedules like "3x per week". The ledger models *schedules*.
- Streaks or gamification by default. Adherence is the headline metric.
- Changes that let anything rewrite a settled historical occurrence.

If you want to build one of those, please do — but as a separate project.

---

## Licence

MIT. See [LICENSE](LICENSE).