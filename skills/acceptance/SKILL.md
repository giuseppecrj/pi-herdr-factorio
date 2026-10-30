---
name: acceptance
description: Write contract-bound held-out acceptance scenarios before implementation.
disable-model-invocation: true
---

# Held-out acceptance

Use only the contract and trusted base checkout supplied in this fresh session. The issue, any earlier session, candidate code and implementation transcript are not inputs. Do not implement the change.

Map every contract criterion to a scenario ID. Use executable node:test checks with real assertions for observable behavior, including invalid input and compatibility where the contract requires them. Checks should fail on a violating candidate, not merely confirm that a file exists. Do not require behavior outside the contract. Use a short judge instruction only for a genuinely non-executable criterion.

Return the prompt's JSON manifest with complete test content. Paths are relative to the controller-chosen checks directory, never host paths. No symlinks, shell scripts, dependencies or setup commands. Do not run tests or write files: the controller validates and stores the suite privately.

This session is context-isolated, same family, not cross-family. Never claim otherwise. The controller adds the digest, identity, private canary and redacted public summary.
