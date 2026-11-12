# Evidence-excerpt replay v1

This is synthetic public work, not a production accept reply or a private oracle.
`replay.json` pins main, the trusted workflow digest, source geometry, required
facts and expected checks. `baseline-build.ts` is the exact build prompt function
from `0f2a046`; comparison of TypeScript-emitted function bodies matched, digest
`9c581eed9feaa304ccc31a16c3ad56b90fce588b64923c136dc4f40ef685e1cd`.

Run from the repository root:

```sh
TMPDIR=/home/g/.cache/eff2-tmp node --experimental-strip-types --test \
  --test-name-pattern='B-shaped' test/sandbox.test.ts
```

The runner gets scripted Pi lifecycle records. Actual Pi 1.4.0 read, grep, edit
and bash tools perform identical work in isolated temporary trees. The real
OpenAI Responses serializer sends each accumulated transcript through the real
local gateway to `startEchoFixture`, using a custom fetch with no external route.
The byte measurement is each serialized request body, not an estimate from the
final transcript. There are ten build requests and ten repair requests per
variant, including the final request after the last tool result.

The build adds a finite-input regression, runs it red, fixes it and runs green.
A public property check still rejects the missing invalid-input behavior. Repair
shifts the implementation by 90 lines while its base citations remain in bounds,
searches the actual workspace, adds the invalid-input regression, runs red,
repairs it and runs green. Both variants must retain every criterion and cited
fact (including implementation and test-harness facts before editing), produce
the same final file bytes and preserve public check outcomes `[false, true]`.
The excerpt identity, omission labels and unchanged contract digest are checked.
The normal strict suite also retains the existing main-owned good/bad gate and
held-out isolation tests; the replay does not weaken or replace them.

Observed local sample on 2026-11-06:

| Measurement | Prefix baseline | Evidence ranges |
| --- | ---: | ---: |
| Serialized provider-input bytes, all turns | 706,844 | 510,899 |
| Requests | 20 | 20 |
| Focused test exits | 1, 0, 1, 0 | 1, 0, 1, 0 |
| Public property checks | false, true | false, true |
| Injected fixture usage | 320 | 320 |
| Real provider/model tokens | 0 | 0 |

The input reduction is **27.7%**, above the required 20%, while retaining 20 lines
of nearby context even when that slightly exceeds the soft 6 KiB target. Timing text from real
focused tests can vary by a few bytes. Injected echo usage is accounting fixture
data, not newly spent model tokens or a monetary price. No VM bundle is installed
or claimed by this local replay. A real all-GPT pilot and PR-quality measurement
remain separate work.

Final local verification passed:

- `TMPDIR=/home/g/.cache/eff2-tmp FACTORY_REQUIRE_SANDBOX_TESTS=1 npm run check`
  — 1,794 passed, zero failed or skipped.
- The same strict environment with the main-owned freeze preload and trusted
  reporter — `complete:true`, `bad:false`, `failures:[]`.
- The installed plan checker — `22 PR sections, 0 problems`.

No push, VM run, model call, subagent or deployment was performed. Independent
cross-family review remains for the coordinator; this bounded task forbids
agents and models. The changed skills require a freshly built trusted bundle
before a later authorized deployment. Personal daily-log writes were outside
this task's allowed files and were not made.

`test/ledger.test.ts` additionally reconciles aggregate receipts, failed retries
and interrupted journals into v3, verifies the charged floor survives missing
execution state, and checks byte-identical v1/v2/v3 round trips. Missing facts
remain unknown, never a claimed zero-token result.

## Fixed accept replay v1

`accept-replay.json` pins the PR 3 base, workflow digest, synthetic public
contract geometry, suite and expected request counts. It contains no production
reply or private oracle. Run it from the repository root:

```sh
TMPDIR=/home/g/.cache/eff3-tmp FACTORY_REQUIRE_SANDBOX_TESTS=1 \
  node --experimental-strip-types --test \
  --test-name-pattern='takes one serialized request' test/sandbox.test.ts
```

The replay builds the core accept prompt, uses Pi 1.4.0's real read, grep and ls
definitions and Responses serializer, then runs the accept runner with scripted
Pi lifecycle records. The real local gateway forwards only to a loopback echo
fixture. A capture between the gateway and that fixture records the actual
outbound body. Bundled skill loading is covered separately by the executor RPC
transport test; this is not a native VM session or a model-quality trial.

The baseline uses the exact `ae49670` prompt instruction stored in the fixture
and PR 2 source ranges, without automatic existing-test excerpts. The fixed
variant supplies both source and public test evidence. The missing-fact control
makes the test unreadable during initial preparation, but available to the real
read tool. Scripted discovery depends on the serialized test evidence, not the
variant name. When that evidence is absent, the script names the missing import
and test-runner fact before one read. Every variant returns the same complete
suite. The suite passes the real isolated base qualification, including its
unchanged tamper scan and repeat run. Criteria, contract bytes and the runner's
three-request ceiling are checked.

Observed local sample on 2026-11-06:

| Measurement | Baseline | Fixed | Missing fact |
| --- | ---: | ---: | ---: |
| Serialized bytes per request | 9,239; 12,106 | 12,982 | 10,134; 13,001 |
| Outbound bytes per request | 9,239; 12,106 | 12,982 | 10,134; 13,001 |
| Total bytes | 21,345 | 12,982 | 23,135 |
| Model requests | 2 | 1 | 2 |
| Read calls | 1 | 0 | 1 |
| Injected usage tokens | 32 | 16 | 32 |
| Real model tokens | 0 | 0 | 0 |

The fixed first request is larger, but total serialized input falls by 39.2% in
this script because the discovery request disappears. All variants hold effort at `low` to isolate
context and request count; this is not a low-versus-medium cost comparison or a
predicted live token saving. Injected usage is echo-fixture accounting data, not spend.
The fixture model's output limit is synthetic; no production output cap changes.

`accept-request.json` preserves one captured fixed request. Minifying that JSON
with `JSON.stringify` yields 12,982 bytes and SHA-256
`722d5316088c5962a0b6008a2f15f166c22fb8c74c8c367d03cc38c9a41c0ca3`.
The replay also prints the full serialized request. A fresh nonce changes its
hash on later runs, not its byte count.

### Tool fallback finding

Keep the current two-call allowance and prefer zero calls in the prompt.
`wrapPiArgv` selects tools at launch, and Pi 1.4.0's RPC command union has no
command to enable tools after a tool-less launch. The existing accept runner
does not have a separate missing-context handshake. Starting with no tools
would therefore need another session or a new control path. Neither is needed
for this bounded fallback. The duplicate-call guard, third-call failure,
three-request backstop and truncated-answer failure remain unchanged.

### Effort finding and pilot recommendation

The bundled agent template has no thinking override. Pi 1.4.0's
`core/defaults.js` sets `DEFAULT_THINKING_LEVEL` to `medium`; `core/sdk.js`
applies it to a fresh session. The hardened wrapper already allows `--thinking`.
The Responses serializer in `pi-ai/dist/api/openai-responses.js` sets
`reasoning.effort`, and `host/gateway/gateway.ts` preserves it while bounding
output. The replay captures `"reasoning":{"effort":"low","summary":"auto"}`
after the gateway. Model capability clamping and provider-side quality still
need a live pilot.

Trusted `stages.accept.reasoning_effort` now accepts `low`, `medium` or `high`,
defaulting to `medium`. It affects accept only, including its named fallback;
other stages reject the key. The controller, executor, wrapper argv and
outbound serialization have regression coverage. The committed workflow is
unchanged.

Recommend `low` for the next authorized pilot comparison, not as a proven
replacement for `medium`. Accept emits compact criterion-linked JSON, and the
base qualification and tamper scan still reject broken suites. Compare low and
medium with interleaved trials on the same pinned contracts, model, bundle and
budgets, including a small contract, a multi-criterion contract and a genuinely
missing-context case. Record:

- qualified suites divided by all generation attempts, plus the ticket-level
  qualification rate after the existing one feedback retry;
- truncated answers divided by all attempts, with ordinary and feedback retries
  reported separately;
- total accept tokens, including failed attempts, fallback sessions and retries,
  and total tokens per qualified suite;
- reasoning versus visible output when the provider supplies it, otherwise
  unavailable, plus request count and wall time.

Keep every criterion and reject a lower-effort setting that reduces qualified
suite yield or adds truncation. Do not raise caps or weaken the oracle to make
the comparison pass. No live trial, VM operation, model call, push or independent
review ran in this bounded task. A later deployment needs a fresh trusted bundle
for the changed acceptance skill. Daily-log writes are outside the allowed
files and were not made.
