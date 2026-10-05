# ADR 0008 — Container packaging: one image, one process, one volume

**Status:** Accepted

---

## Context

NF6 requires trivial installation: one command, SQLite only, no external
services. The server already serves the API and the built PWA from a single
process (ADR 0006), so packaging is a matter of shipping that process with its
build outputs. `better-sqlite3` is a native module, which constrains the base
image choice.

---

## Decision

**Multi-stage `node:22-slim` image, Debian glibc deliberately.**

- The build stage installs all dependencies and runs `pnpm build` (server
  bundle + web dist). Dependency layers sit below the source copy so edits do
  not reinstall.
- The runtime stage reinstalls production dependencies only and copies in just
  the two build outputs. `node:22-slim` (glibc) is chosen because
  `better-sqlite3` ships prebuilt binaries for it; musl/Alpine would compile
  from source on every build.
- One process, one SQLite file on a `/data` volume (`DB_FILE`), so the ledger
  survives image rebuilds. A named volume rather than a bind mount: WAL shared
  memory needs a POSIX filesystem, which Windows/Mac host mounts do not
  provide (`SQLITE_IOERR_SHMOPEN` on first boot, verified).
- `HOST=0.0.0.0` is set in the compose file. The server default binds
  loopback, which accepts only connections from inside the container — the
  single most likely way to ship a "working" image nobody can reach.
- `HEALTHCHECK` probes `/api/health`.
- The container runs as root. Stated plainly because it is a real trade, not an
  oversight; see below.

---

## Consequences

**Positive**

- `docker compose up -d --build` is the whole deployment: port mapping, volume
  and bind address in one reviewed file.
- CI builds the image, boots it, and probes rule creation plus CSV export —
  after a bare `node_modules` in `.dockerignore` once shipped absolute host
  symlinks into the image, which no typecheck could see. (Bare patterns match
  only the context root; every entry needs `**/`.)
- Production dependencies only at runtime: no `sharp`, no test runners.

**Negative — accepted**

- Root in-container. A non-root user breaks first boot on a bind mount the
  daemon creates as root, which trades a theoretical container-escape surface
  for a guaranteed support burden on every new install. Accepted for a
  single-user home server that binds without auth by design (D10); revisit with
  PUID/PGID mapping if the threat model ever changes.
- ~400 MB image. Layer caching keeps rebuilds fast; squeezing comes later if
  ever.
- amd64 only for now. ARM runners and `buildx` matrices are future work.

---

## Alternatives considered

### Alpine base

- **For:** smaller image.
- **Against — rejected:** musl has no `better-sqlite3` prebuild, so every build
  compiles native code (needs python/make/g++ in the image) and every upgrade
  risks a toolchain break. Size is not worth it at this scale.

### Single-stage image

- **Against — rejected:** ships devDependencies (`sharp`, vitest, vite) and the
  full source tree to every user. Larger, slower to pull, wider surface.

### Separate frontend host / reverse proxy in the image

- **Against — rejected:** ADR 0006 already decided one process serves both. A
  proxy inside the image would add a second moving part to avoid none.
