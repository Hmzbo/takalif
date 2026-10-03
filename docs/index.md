# Documentation

Technical documentation for engineers working on or integrating with Takalif.

Read these in rough order:

| Document | What it covers |
|---|---|
| [`overview.md`](overview.md) | The idea, what it is, and what it deliberately is not |
| [`requirements.md`](requirements.md) | Functional and non-functional requirements |
| [`features.md`](features.md) | Feature-level behaviour, described precisely |
| [`architecture.md`](architecture.md) | System architecture, the client/server split, data flow |
| [`data-model.md`](data-model.md) | Entities, schema, and the invariants that protect user data |
| [`statistics.md`](statistics.md) | The adherence formulas, worked through |
| [`calendars.md`](calendars.md) | Recurrence, RFC 5545 RRULE, and Gregorian + Hijri support |

[`adr/`](adr/index.md) records why each architectural decision was made. When a
decision is superseded, write a new ADR that supersedes it rather than editing
history.

[`AGENTS.md`](../AGENTS.md) covers the practical rules of working in this
repository: domain invariants, where logic belongs, testing expectations, and the
git workflow.
