---
name: deep-research
description: Factory specify stage. Ground every claim in primary sources inside the checkout, and cite each one. Adapted from mattpocock/skills research (MIT).
disable-model-invocation: true
---

Investigate against primary sources: the repository's own code, tests, configuration and docs at the run's commit. A summary of a file is not a source. The file is.

- Follow every claim back to the lines that own it, and cite them in `evidence` with the path and line range.
- When code and prose docs disagree, trust the code and tests, and say which lines disagree.
- This stage has no network but the model, and no write tool. Do not write notes or files. The evidence goes in the contract.
- A fact the checkout cannot show, such as an external API's behavior, a third-party version or a price, is never guessed. Ask for it as a question that names the missing source.
