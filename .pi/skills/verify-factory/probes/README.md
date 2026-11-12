# probes

This folder holds the probe programs that verify-factory feature recipes run against a lane's stored run on the VM. Each one checks an isolation boundary with a real sandbox and spends no model tokens. They began as prototypes under `docs/history/prototypes/`, where their evidence and history still live. `docs/history/path-map.md` records the move.

| Probe | Run by | What it proves |
| --- | --- | --- |
| `acceptance-isolation/probe.ts` | `features/acceptance.md` | A build-profile sandbox launched after accept cannot reach the stored held-out suite or an earlier stage's records. |
| `acceptance-isolation/self-test.mjs` | `test/src/contract/artifacts.test.ts`, before the live probe | The acceptance probe's detector and PASS predicate reject each planted leak. |
| `build-isolation/probe.ts` | `features/build.md` | A sandbox with the real build mount shape cannot reach held-out acceptance material. |
| `build-isolation/self-test.mjs` | `features/build.md`, before the live probe | The build probe's detector and PASS predicate reject each planted leak. |
| `heldout-ci/repair-probe.ts` | `features/validation.md` | A repair sandbox gets only approved feedback and cannot retrieve published checks through GitHub, npm or a model tool. |

`npm run check` typechecks, lints and formats these files like the rest of `.pi/skills/`. A self-test reads its probe's source by relative path, so move a probe and its self-test together.

Run a self-test with `node --test <path>`. Run a live probe on the VM with `XDG_RUNTIME_DIR=/run/user/1000 node <path> <state-dir> <run-id>`. The build probe also takes the attempt number. Each feature recipe lists what to require from the output.
