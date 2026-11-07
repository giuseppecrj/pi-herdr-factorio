---
name: acceptance
description: Write contract-bound held-out acceptance scenarios before implementation.
disable-model-invocation: true
---

# Held-out acceptance

Use only the contract and trusted base checkout supplied in this fresh session. On the one accept retry only, the author's own refused suite and bounded refusal feedback are also inputs; fix that suite rather than rewrite it unless the feedback requires it. The issue, other earlier-session material, candidate code and implementation transcript stay excluded. Do not implement the change.

Treat this as one structured generation request. Use the complete contract and checkout-bound source and existing-test excerpts to return the complete suite in one reply. Prefer zero tool calls. Omission labels mean other code exists, not that you must browse it. Only when a fact needed for a correct check is missing, name that fact before requesting it. Then read 80 to 120 lines with offset/limit, or grep with limit 10 to 20 and context 2 to 3; refine the search rather than paginate it. A larger relevant block is allowed when justified. Stay within the same two-call allowance across this whole session, including revisions. Never read test/acceptance, held-out material, controller state or other sessions. Do not drop a criterion or assertion to fit.

Map every contract criterion to a scenario ID. Use executable node:test checks with real assertions for observable behavior, including invalid input and compatibility where the contract requires them. Checks should fail on a violating candidate, not merely confirm that a file exists. Do not require behavior outside the contract. Use a short judge instruction only for a genuinely non-executable criterion.

Each criterion has a kind, `new_behavior` or `preservation`. A scenario maps criteria of one kind only, and the controller derives the scenario's kind. Each checked scenario owns exactly one check file, never shared with another scenario; put helpers inside that file. Every `new_behavior` criterion needs a checked scenario.

Before build, the controller runs the checks against the unchanged base, with no network, no Git and no `.git`. A `new_behavior` file must fail at least one assertion there, and its other tests must pass or fail by assertion. A `preservation` file must pass entirely. A load error, an in-body non-assertion error such as a missing command, a file with no tests, a skip, a todo or a timeout refuses the whole suite before build.

The controller may run your draft against the unchanged base and return bounded results in this same session, at most twice per attempt. Fix author errors without weakening coverage, then reply with the complete suite, not a patch. Import modules directly; do not spawn a nested test runner or transpile and execute an existing test file.

Return the prompt's JSON manifest with complete test content. Paths are relative to the controller-chosen checks directory, never host paths. No symlinks, shell scripts, dependencies or setup commands. Do not run tests or write files: the controller validates and stores the suite privately.

This session is context-isolated, same family, not cross-family. Never claim otherwise. The controller adds the digest, identity, private canary and redacted public summary.
