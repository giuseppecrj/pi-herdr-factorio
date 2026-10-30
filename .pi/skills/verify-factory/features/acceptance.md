# Held-out acceptance (F06b)

From F06b, a specify pass with a contract moves the same run to the `accept` stage. Accept writes held-out scenarios from the contract alone and the controller stores them privately. The behavior and the files are documented under "Acceptance" in `docs/operations/factory-cli.md`.

Every passing lane spends model tokens and needs the model-spend grant as well as the fixture grant. Never export suite code or the canary to GitHub, the PR or a local trail. Keep suite bytes on the VM.

## Sub-features

- `accept-flow`: markers `1:claimed`, `2:running` at `specify`, then `3:claimed`, `4:running`, `5:stage_passed` at `accept`, all in one `tick --once`. The contract summary lands before `3:claimed`. One acceptance summary lands before `5:stage_passed`. The log has `contract_stored`, then `acceptance_stored digest=<acceptanceDigest>`.
- `accept-summary`: the comment ends `<!-- factory-acceptance run=<runId> a=<acceptanceDigest> -->`, lists `S<n>: A<n>, ...` and says `context-isolated, same family, not cross-family`. It has no file path, test code, judge text or canary.
- `accept-store`: `<state>/acceptance/<runId>/` holds `receipt.json`, `suite.json`, `manifest.json`, `checks/*` and `canary.txt`, mode 0600 in 0700 directories, plus the anchor `<state>/acceptance/<runId>.json`. The receipt's `contractDigest` and `baseSha` match the contract receipt, and its `isolation` is the family disclosure. A fresh `fileRunFiles(<state>).artifacts.read` returns `found` and its digest equals `acceptanceDigestOf` recomputed from the stored bytes.
- `accept-canary`: the canary is in `canary.txt`, `suite.json` and every check file, and not in the receipt.
- `accept-isolation`: `docs/prototypes/acceptance-isolation/probe.ts` against the stored run prints `"result": "PASS"` and spends no model tokens.
- `accept-needs-info`: a specify `needs_info` never launches accept.

## Driving it with ssh

Preconditions are those of `specify.md`. `readlink /var/lib/factory-sandbox/current` must name a bundle whose `skills/` lists `acceptance`. Re-provision with `bash server/provision.sh sandbox` from the lane workspace when `skills/acceptance/` changes.

1. Run the doctor, snapshot the VM, set up the lane and record its head and bundle digest.
2. Create a `[<pr-id>] ...` fixture issue as the owner, then add `factory:ready` as the owner. Do not touch `factory:enabled`.
3. Run `vm.sh drive-stage.sh <pr-id> <worker-n> <issue>`. Its evidence lists the specify and accept receipts and their egress.
4. On the VM, read both receipts and check the store with a script in the lane workspace that calls `fileRunFiles(<state>).readContract` and `artifacts.read`. Print modes, digests, scenario IDs, criteria and file sizes only.
5. Count specify's root receipt once and accept's receipt once. Per-request tokens are `inputTokens` and `outputTokens` in each session's `egress.jsonl`. Accept must stay under 25,000 tokens and 5 minutes, and specify plus accept under 45,000 tokens and 10 minutes.
6. Run `node docs/prototypes/acceptance-isolation/probe.ts <state> <runId>` from the lane workspace with `XDG_RUNTIME_DIR=/run/user/1000`.
7. Read the comments through `gh` and check `accept-summary`.
8. Close every fixture, confirm CLOSED, snapshot again and run `cleanup.sh`.

## Results observed

On 2026-10-30, lane `f06b-w1`, bundle `assets-0e2b7ea8faceb746…`, the fixed three-criterion fixture "Add a clamp helper in src/clamp.ts", labeled by `giuseppecrj`:

| Fixture | Head | Specify tokens / requests / wall | Accept tokens / requests / wall | Total tokens | Tick wall | Scenarios |
| --- | --- | --- | --- | ---: | --- | --- |
| #459 | `37ccf2f` | 11,356 / 4 (3 draft, 1 review) / 43.3 s | 11,932 / 3 / 76.6 s | 23,288 | 134.4 s | S1–S8 over A1–A8 |
| #460 | `1611c7b` | 11,376 / 4 (3 draft, 1 review) / 38.3 s | 8,200 / 2 / 44.7 s | 19,576 | 97.1 s | S1–S7 over A1–A7 |

Specify turned the issue's three criteria into seven or eight finer ones. Every model request was `openai/gpt-6.1-sol`. The isolation probe passed on #460's run. Both fixtures are closed, and the lane was removed with no scope or process left.

## Gotchas

- `lane-setup.sh` deletes the lane's `state`. Running it again after a stage destroys the stored suite. Run the probe from the same lane setup.
- The probe's `systemctl --user stop` of its scope may report failure because the scope already ended with its process. Check the leftover scope count instead.
- Recovery and hostile-output cases run in `test/orchestrator.test.ts` and `test/artifacts.test.ts`: invalid or empty output retries and then fails; budget output is dropped with its usage counted; a stored suite is reused after a restart without a new model request; damaged bytes end `failed` with a typed reason and are never regenerated.
