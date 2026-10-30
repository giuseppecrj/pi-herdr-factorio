---
name: grill-me
description: Factory specify stage. Settle every fact from the repository first, then turn the decisions only the owner can make into a few specific questions. Adapted from mattpocock/skills grilling (MIT).
disable-model-invocation: true
---

Map the ticket as a design tree: every decision branches into the decisions that hang off it.

The frontier is every decision whose prerequisites are already settled. Work it before anything else.

- Finding facts is your job, never the owner's. Settle each fact from the repository map, the inlined files, or a read, grep or ls call. Never ask the owner what the repository answers.
- The decisions are the owner's. A decision that changes behavior, and that neither the ticket nor the repository settles, becomes a question.
- Ask only the frontier. A question whose answer depends on another open question belongs to a later round: leave it out.
- Word each question so one line answers it, and so "yes" accepts the reading you recommend. Name the options when there are few.
- Cite the repository lines that make the question necessary.

This stage cannot wait for answers. When the frontier is not empty, reply with the questions in the output schema and stop. The owner answers on the issue and adds the ready label again, and the next run reads the answers.

When the frontier is empty, every branch is visited and nothing is silently assumed. Then write the contract.
