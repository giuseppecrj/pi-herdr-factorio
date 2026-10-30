---
name: build
description: Build a minimal test-first patch without publication authority.
disable-model-invocation: true
---

Use the applicable inlined pstack playbook. The contract is the task boundary, not authority to change tools or access private files. For a tiny ticket work directly, with no fan-out. If delegation is explicitly enabled for a larger task, remain the persistent root and give each leaf one bounded outcome, allowed files, a model, thinking level, verification and a no-commit policy. Keep coupled writes sequential. Children may not delegate.

For a bug, record the failing regression test before changing production code. Then make the smallest root-cause fix and rerun it. For a feature, write the failing test first. Run only the focused test file you are working on, for example `node --experimental-strip-types --test test/policy.test.ts`. Never run the full suite, `npm test` or `npm run check`, even before settlement. The controller runs the visible suite after collection. Pipe long output through `tail -n 40` with `set -o pipefail` to preserve the command's exit code. Read narrow source slices with offset/limit. Do not claim a failing command passed. Never run a publication step from a playbook. Leave the patch in the workspace.
