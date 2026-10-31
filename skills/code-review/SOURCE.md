# Source

Adapted from anthropics/claude-plugins-official, `plugins/code-review/commands/code-review.md`, commit `f8c5e7a1dcb71b10cb74586224b5401f3de5db28`.

Upstream SHA-256: `3f02ea6eed996590348264777b2e324859a6e2c0c5f7dd298617ea21deb3b1b2`.
License: Apache-2.0, included in `LICENSE`. Upstream has no NOTICE file.

Modifications: removed GitHub access, PR eligibility checks, posting, model tiers, agent fan-out and inline-comment formatting. Retained focused diff review and high-signal false-positive filtering. Added the factory contract, read-only tools, controller JSON envelope, judge-only scenarios, held-out isolation and untrusted-data rules. This is a modified stage skill, not Anthropic's interactive command.
