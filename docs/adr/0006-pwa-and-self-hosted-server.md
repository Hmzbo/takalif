# ADR 0006 — PWA client, self-hosted server as source of truth

**Status:** Accepted

---

## Context

The app must be usable from a PC (Windows/Linux) and an Android phone, with data
in sync. That raises the question of where the source of truth lives, and whether
a peer-to-peer mesh is needed to avoid a server altogether.

---

## Decision

**A self-hosted server is the source of truth. Clients are replicas.**

The client is a **PWA** — one React codebase covering Android, Windows and Linux,
installed from the browser rather than an app store.

The server is a single process with SQLite. No external database, no account.

---

## Consequences

**Positive**

- One codebase for every target platform.
- No app store, no review process, no APK signing. Updates ship with the server,
  which matters for an OSS project.
- Reliable server-side reminders, independent of whether a client is open.
- One SQLite file; `docker compose up` is the whole deployment.
- No distributed consistency problem: there is exactly one writer.

**Negative — accepted**

- Desktop push requires the browser to be running. Mitigated by an email and
  ntfy fallback.
- Clearing browser site data wipes the local cache. Harmless, because the server
  holds the canonical copy.
- A browser must be installed on the desktop. Not a real constraint for the
  target platforms.
- Running a server is required. Accepted as the price of a sane sync model, and
  the same trade every comparable self-hosted project makes.

---

## Alternatives considered

### Phone as source of truth, desktop as thin client

- **Against — disqualifying:** Android does not reliably run background code
  (Doze, battery optimisation, OEM kill lists). If the phone app is asleep, there
  are no reminders and sync silently stops.
- A phone is a single point of failure: lost, reset, or reinstalled, and there is
  no fallback and no server to re-pull from.
- Worst possible installation story for other users, whose devices vary widely.

### Peer-to-peer mesh (CRDT, e.g. Automerge or Yjs)

- **For:** no infrastructure, no hosting cost, no accounts, true offline-first.
  For an append-only workload, the conflict rate would genuinely be near zero.
- **Against — disqualifying for this product:** no reliable web push; statistics
  queries would need a full replica on whichever device is answering; and a sync
  protocol to debug across unreliable mobile networks.

A bad trade for one user with two devices.

### Native Android + native desktop

Kotlin/Compose for Android plus a separate desktop client is two or three
codebases for the same feature set, with no shared test surface. Rejected for
v1; the PWA choice is not a dead end, since the React frontend can later be
wrapped in Tauri for native shells with no loss of code.

---

## Offline

Cached reads plus an outbox for writes. Not full offline-first.

Deliberate: a statistics application needs a canonical view, and full offline
conflict resolution would reintroduce the complexity the server removes.
