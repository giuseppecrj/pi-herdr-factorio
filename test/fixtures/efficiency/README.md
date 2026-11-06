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
