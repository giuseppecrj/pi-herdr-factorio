# Host controller

The CLI in `server/cli.ts` composes these host ports with the scheduler in `src/orchestrator.ts`. No module here schedules candidate stages independently. `server/` stays in place until L13.

| File | Owns |
| --- | --- |
| `serve-loop.ts` | The tick loop, structured logs, systemd notifications and metric snapshot refresh. |
| `lock.ts` | Abstract socket acquisition, process start identity and lock release. |
| `checkout.ts` | Bounded tarball fetch and parsing, persisted checkout lists and pristine build workspaces. |
| `checkers.ts` | Draft, base and diagnosis checks, including their job maps, aborts, deadlines and settlement. |
| `run-files.ts` | Claims, workspaces, contracts, links, answers and preparation's pinned policy cache. |
| `state.ts` | Private file writes and parsers, accounting and verification records, assessments, and read-only lock/status/verdict access. |
| `outbox.ts` | The ledger outbox, its backlog and its publication pump. |
| `terminal.ts` | Receipt-only terminal evidence, durable charges and the usage refresh cache. |
| `measurement.ts` | Score publication, bounded measurement execution and automatic measurement queues. |
| `cadence.ts` | The cadence execution port, proposal publication and score-trigger proposals. The domain CadenceRunner owns cadence scheduling. |
| `validation-sweep.ts` | Candidate and owner validation, trusted report collection, receipt downloads and the single validation cleanup sweep. |
| `candidate-port.ts` | Candidate GitHub effects, pinned handoff settings, feedback records, notices and merged-feedback proposals. |

Import the owning implementation directly. Do not add a barrel or a compatibility export. Keep each factory's mutable cache, job map and callbacks together. A proposed extraction stops if it needs the mutable parent object or more than four mutable fields owned elsewhere.

The cadence repository root is two levels above its module. Diagnosis compares the gate tree's `server/gates.ts` bytes with `../gates.ts` relative to `checkers.ts`. Both readers have entries in `scripts/layout-baseline.json`. Keep those entries and the path map current when moving code.

Characterization and recovery pins are in `test/host-controller.test.ts`; the existing orchestrator, publication, validation, diagnosis, cadence and measurement suites exercise these ports through their callers.
