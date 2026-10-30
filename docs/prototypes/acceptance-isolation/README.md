# Acceptance isolation: the pre-build boundary (F06b)

Question: once accept has stored a held-out suite, can a later build stage for the same run find the suite's code, its private path or its canary?

## What is planted

`<state-dir>/acceptance/<runId>/` holds `suite.json`, `manifest.json`, `checks/*`, `canary.txt` and `receipt.json`, mode 0600 in 0700 directories, plus the anchor `<state-dir>/acceptance/<runId>.json`. The canary is `factory-holdout-<64 hex>`, random per suite. It is in `canary.txt`, in `suite.json`, and on the last line of every check file, so any file that leaks test code also leaks the canary.

## The probe

`probe.ts <lane-state-dir> <runId>` runs on the VM against a run whose suite is stored. It launches one sandbox the way `sandboxHost` launches a stage: a `systemd-run --user` scope, the seccomp filter, a fresh per-stage gateway with the build route table, a fresh agent dir copied from the bundle template, the run's own workspace bound at `/workspace`, and the build tool list `read,grep,ls,bash,write,edit`. In place of Pi it runs a fixed Node script, so it makes no model request. The script:

- learns the host state path from `/proc/1/cmdline` (a known disclosure, issue #425), then tries to read the suite, the anchor, the canary, the contract, and accept's and specify's `output.txt` and session directory at their host paths;
- checks `/proc/self/mountinfo` for any acceptance or earlier-stage mount;
- checks `/workspace/.git` is the empty masked tmpfs, the agent's `sessions/` is empty, `/home`, `/tmp` and `/run` are fresh tmpfs mounts, and no cache, credential or `/root` path exists;
- checks the environment holds no SSH agent, GitHub or OpenAI credential and no `NODE_OPTIONS`;
- reads every regular file under 4 MiB in `/workspace`, `/run`, `/home`, `/tmp`, `/opt/factory` and `/etc` and searches for the canary pattern;
- asks the gateway for a GitHub route and tries direct HTTPS to `api.github.com`.

The host side then checks the probe's stdout and stderr for this suite's canary, stops the scope and the gateway, and removes the probe's stage and gateway directories.

## Result

2026-10-30, lane `f06b-w1` at `1611c7b`, bundle `assets-0e2b7ea8faceb746…`, run `37d94e3ca79d…` from fixture #460, acceptance digest `8c6a9c725581…`:

| Check | Result |
| --- | --- |
| Private host paths readable (8 tried) | 0 |
| Acceptance or earlier-stage mount | none |
| `/workspace/.git` entries | 0 |
| Own `sessions/` entries | 0 |
| `/home`, `/tmp`, `/run` | fresh tmpfs; `/home/agent` holds only stage-init's Herdr config and sockets |
| Cache, credential or `/root` paths | none |
| Credential environment variables | none |
| Tools | `read,grep,ls,bash,write,edit` |
| Files scanned for the canary | 22,891, 0 hits |
| Gateway GitHub route | 403 |
| Direct GitHub | denied |
| Canary in probe stdout or stderr | no |
| Model requests | 0 |

Result: PASS. Leftover scopes and sandbox processes afterwards: 0.

The same probe passed again at `fff4922`, after the last code change, on run `37378d4ce8a9…` from fixture #461 (acceptance digest `8e42ef8ce039…`), with the same figures. There the canary was in `suite.json`, `canary.txt` and both check files, and in no other file of the lane state.

## The boundary this records

Before any build exists, the build-profile sandbox gets the run's workspace (the trusted base checkout), its own fresh agent dir, a gateway with no GitHub route, and the bundle. It does not get `<state-dir>/acceptance/`, `<state-dir>/contracts/`, or any other stage's directory. A future build stage must keep that layout: pass the contract and scenario IDs in its prompt, as `ARTIFACT_ACCESS.build` in `src/artifacts.ts` records, and never bind the acceptance store.

Not covered here:

- Post-publication repair isolation, after F07c publishes the tests to a PR. That boundary belongs to F07c.
- The host paths in `/proc/1/cmdline`. They name the state directory, but the paths are not mounted, so they cannot be read.
- A build stage that is given `bash` and network routes beyond the model. F07a defines that stage's routes, and must rerun this probe with them.
