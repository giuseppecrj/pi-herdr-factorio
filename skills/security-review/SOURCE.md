# Source

Adapted from anthropics/claude-code-security-review, `.claude/commands/security-review.md`, commit `0c6a49f1fa56a1d472575da86a94dbc1edb78eda`.

Upstream SHA-256: `dd1d451f909dbb8798f4a4de010c35e7dd9152f02bb2f7988442cdd138f29e39`.
License: MIT, Copyright (c) 2025 Anthropic, included in `LICENSE`.

Changes: removed shell substitutions, Git commands, Task fan-out, Markdown output and numeric confidence scoring. Retained concrete exploitability, focused data-flow review and false-positive exclusions. Added the factory's read-only tools, JSON seat schema, private-oracle boundary and untrusted-data framing.
