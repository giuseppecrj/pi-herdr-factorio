# Anthropic route: one metered accept-shaped call (F10c)

Question: can a stage sandbox on `pi-factorio` complete one metered Anthropic call through the real gateway before any stage is wired to Anthropic? The plan makes this a stop gate. A 400 or an unmetered result means stop and do not start slice 2.

## What it runs

`probe.ts` runs on the VM host. It does not use the controller, a ticket or a workflow.

- It builds `builtinTable({ provider: "anthropic", model: "claude-sonnet-5-5" })`, so accept's primary is `anthropic/claude-sonnet-5-5` on `model-anthropic`. It starts the real gateway process (`startGatewayProcess`, production table mode) against `https://llm.int.exe.xyz/anthropic`.
- The ceiling is the accept cap, 25,000 tokens, and one model request. The gateway closes its own gate as it admits the first request, so a second call cannot leave. Pi's `max_tokens` (128,000 from its model card) is clamped to 25,000 and journaled as `maxOutputTokens`.
- It runs real Pi from the installed sandbox bundle inside a real stage sandbox (`launchSandbox`: bwrap, seccomp, user scope, in-sandbox forwarder). Pi uses the bundle's `models.json` `anthropic` provider from `server/provision.sh`, with no credential. The gateway strips Pi's placeholder `x-api-key` and forwards `anthropic-version` and `anthropic-beta`, which Pi's SDK sends itself.
- Pi gets the real accept system prompt (`STAGE_SYSTEM_PROMPT`), the accept tools (`read,grep,ls`), the acceptance `SKILL.md` inlined by `withSkills`, and the wrapper's forced `--no-context-files`. The only added text is one line asking for the word `ok` with no tool call. The input is therefore the size of a real accept stage before its contract and inlined files. A real contract adds more.
- Pi runs in `--print` mode, not the runner's RPC mode, with `--thinking off`. The request body and headers come from the same Pi provider code. Thinking is off for qualification, as the arena synthesis set. An Anthropic stage with thinking on is not proven here.

Expected spend is one call: about the prompt plus tools and skill in, a few tokens out, plus any cache write Pi's `cache_control` triggers. Cache tokens count as input.

## Run it

Re-provision the sandbox bundle from this branch first, so the bundle has the `anthropic` provider. The probe refuses to start otherwise.

```sh
bash server/provision.sh sandbox
node docs/prototypes/anthropic-route/probe.ts ~/f10c-anthropic-probe
```

An optional second argument names another table model, such as `anthropic/claude-haiku-5-5`. The out-dir must not exist. The probe keeps `stages/<runId>/accept-1/` under it, holding `egress.jsonl` (the gateway audit), `egress.requests.jsonl` (the journal) and Pi's session under `agent-0/sessions/`. Pi's stderr goes only into the receipt. It writes `receipt.json` in the out-dir and prints the same JSON.

## Receipt

- `audit`: every gateway audit line, with `observedModel` on the metered call.
- `journal`: the dispatch (`inputTokenEstimate`, `maxOutputTokens`) and the result (`status`, `inputTokens` including cache, `outputTokens`, `observedModel`).
- `charge`: `journalCharge` of that journal.
- `summary`: the gateway's per-route meter receipt at shutdown.
- `pi`: exit code, the first 400 characters of stdout and the last 2,000 of stderr.
- `checks` and `pass`. Pass requires exactly one dispatch and result, status 200 forwarded, numeric tokens, an `observedModel` that is a bare table id equal to the requested model, `maxOutputTokens` at most the model's table maximum, route `model-anthropic`, and Pi exiting 0.

Save the receipt here as `receipt.json` once it has run. Review it for anything that should not be committed first. It holds no credential, but the session directory holds model text.

## Result

Not run yet. The coordinator runs it on `pi-factorio`.
