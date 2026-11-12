# .pi/skills

This folder holds coordinator skills. A Pi session started in this checkout loads them. They are not the factory's stage skills, which live in `skills/` and ship in the sandbox bundle.

| Skill | Use it to |
| --- | --- |
| `verify-factory/` | Verify the factory on its real surfaces: VM lanes, the CLI, the extension, the viewer and exact-head CI. Start at `verify-factory/SKILL.md`, then `features/README.md`. |
| `verify-factory-state/` | Rerun the existing bounded F1 to F4 state checks and runtime correspondence. Start at `verify-factory-state/SKILL.md`. |
| `project-status/` | Write an evidence-based snapshot of the goal, done work, current work and owner decisions. |
| `daily-log-pi-herdr-factorio/` | Read and append the untracked daily log in `.pi/daily-log/`. |

`verify-factory/scripts/` holds the lane drivers, and `verify-factory/probes/` holds the probes that feature recipes run. Tests read some of them by path, and `npm run check:layout` inventories every path token in their shell scripts. If you move a file that a driver names, update the driver and `shell.inventory` in `scripts/layout-baseline.json` together.

## Add a skill

Create `<name>/SKILL.md` here for a procedure a coordinator session follows. A prompt that a factory stage runs belongs in `skills/` instead.
