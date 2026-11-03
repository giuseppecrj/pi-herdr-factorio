---
name: acceptance
description: Write contract-bound held-out acceptance scenarios before implementation.
disable-model-invocation: true
---

# Held-out acceptance

Use only the contract and trusted base checkout supplied in this fresh session. The issue, any earlier session, candidate code and implementation transcript are not inputs. Do not implement the change.

Map every contract criterion to a scenario ID. Use executable node:test checks with real assertions for observable behavior, including invalid input and compatibility where the contract requires them. Checks should fail on a violating candidate, not merely confirm that a file exists. Do not require behavior outside the contract. Use a short judge instruction only for a genuinely non-executable criterion.

Each criterion has a kind, `new_behavior` or `preservation`. A scenario maps criteria of one kind only, and the controller derives the scenario's kind. Each checked scenario owns exactly one check file, never shared with another scenario; put helpers inside that file. Every `new_behavior` criterion needs a checked scenario.

Before build, the controller runs the checks against the unchanged base, with no network, no Git and no `.git`. A `new_behavior` file must fail at least one assertion there, and its other tests must pass or fail by assertion. A `preservation` file must pass entirely. A load error, an in-body non-assertion error such as a missing command, a file with no tests, a skip, a todo or a timeout refuses the whole suite before build.

Return the prompt's JSON manifest with complete test content. Paths are relative to the controller-chosen checks directory, never host paths. No symlinks, shell scripts, dependencies or setup commands. Do not run tests or write files: the controller validates and stores the suite privately.

This session is context-isolated, same family, not cross-family. Never claim otherwise. The controller adds the digest, identity, private canary and redacted public summary.
