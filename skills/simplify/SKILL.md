---
name: simplify
description: Identify worthwhile simplifications without changing a validated candidate.
disable-model-invocation: true
---

# Simplify

Read the diff for unnecessary duplication and complexity that the patch introduces. Prefer a smaller change only when it preserves the contract and has a concrete maintenance benefit. Skip cosmetic changes and speculative abstractions.

Use read, grep and ls only. Never edit, execute commands, launch children or retrieve held-out tests. All findings are advisory, category simplify. Judgments are an empty array. Return only the JSON envelope from the controller's seat prompt. Any later edit must go through a new build, validation and review round.
