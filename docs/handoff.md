# Handoff

Written 2026-10-28 by the session that started this project (Pi session `01a1840a-36b4-7758-a881-5f7de4ddab25`, herdr pane `wJ:p1`). The owner is moving the work to a new session. Read this file, then the files it points to, before acting.

## Goal

Build `pi-herdr-factorio`, a Pi package that works like a software factory: a GitHub issue labeled `factory:ready` runs through fixed stages (specify, accept, build, validate, review, handoff) and ends at a ready PR the owner merges. It bundles the skills from Cory House's post (https://x.com/housecor/status/2115482034906800200) and depends on pi-herdr-pstack. The coordination layer copies OpenAI's Symphony spec.

## How to work

- The owner runs `/poteto-mode`. Run `/poteto-mode on` in this session if it is not already on, and follow the hub. This project runs under the figure-it-out route; the build itself runs under the plan's `playbooks/autopilot-stack.md`.
- Owner rules are in `~/.pi/agent/AGENTS.md`: explicit model and thinking on every child, cross-family independent review where possible, children are leaves, inspect diffs yourself, no external action without a grant, Tailscale links never localhost.
- No task-model categories are configured, so `task:<category>` throws. Use exact `cliproxyapi/<model>` IDs from the live catalog for local children.
- Keep logging decisions with `/home/g/.pi/agent/npm/node_modules/pi-herdr-pstack/skills/show-me-your-work/scripts/log.sh docs/decisions.tsv <phase> <decision> <why> <evidence> <result>`. Your first row is phase `start`, naming this session as the previous writer.

## Read first

1. `docs/design.md` is the spec, current as of `04b69c3`.
2. `docs/decisions.tsv` is every decision with its evidence. It is the authoritative history; this file does not repeat it.
3. `docs/plans/factory-v1.md` is the build plan: 16 serial PRs, `F04a` to `F13`. `check-plan.mjs` passes.
4. `docs/prototypes/herdr-on-runner.md`, `research/SYNTHESIS.md`, `research/PROVENANCE.md` and `research/reports/` hold the evidence behind the design.

## Owner decisions in force

- GitHub Issues now, Linear later through the same `TicketAdapter`, polled like GitHub.
- v1 ends at Human Review. The owner merges every PR, including the factory's own build PRs. Full autonomy comes later through the checkpoint policy.
- The controller runs on the exe.dev VM `pi-factorio` and talks to GitHub with plain `gh` through exe.dev's GitHub integration. No GitHub App, no webhooks, no Tailscale.
- Models on the VM come from exe.dev's `llm` integration. The default for every stage is `openai/gpt-6.1-sol` (ChatGPT subscription). Do not use Anthropic on the VM: it spends exe.dev credits. Anthropic returns when the owner plugs in his own proxy provider. Until then review seats are same-family and must be labeled context-isolated.
- pstack is a hard dependency. The factory's first target repo is this repo.

## State

- Repo `giuseppecrj/pi-herdr-factorio`, public, `main` clean. Repo secrets and variables are empty.
- Verified units 0 to 3 (see design build order): CI model access over the tailnet (since retired), headless Herdr subagents on a runner, the package skeleton (`npm run check` 60/60), VM bring-up.
- Local branches `factory-skeleton` and `factory-herdr-probe` are merged and kept; `factory-herdr-probe` also exists on origin. Their worktrees were removed with the owner's approval.
- Labels exist: `factory:ready`, `factory:review`, `factory:needs-info`, `factory:proposed`.
- No children are running.

## VM

- Reach it with `SSH_AUTH_SOCK=$HOME/.ssh/headless-agent.sock ssh pi-factorio.exe.xyz` (user `exedev`). The same socket drives `ssh exe.dev <command>` for the exe.dev CLI.
- Provisioning is `server/provision.sh`. Rerun it with `ssh pi-factorio.exe.xyz bash -s < server/provision.sh`. It installs Node 22, Pi 1.4.0, Herdr 0.9.5, pi-herdr-agents, pi-herdr-pstack, and sets the default model.
- `GH_HOST=github.int.exe.xyz gh ...` reads and writes this repo as `exe-dev-github-integration[bot]`. Integration name `pi-factorio-repo`, attached to this VM only. Repo-scoped calls work; `gh api user` does not.
- Models: `https://llm.int.exe.xyz`. Pi's built-in `anthropic` and `openai` providers point there in `~/.pi/agent/models.json` on the VM.
- Docker is installed but not rootless. `github.int.exe.xyz` and `llm.int.exe.xyz` resolve to the same address, so the sandbox must filter by hostname, not IP (plan risk R1, PR `F05`).

## Waiting on the owner

1. Run the plan as written (10 live lanes per PR, swarm verdicts) or trimmed (2 to 4 meaningful checks per PR, perf only on model stages, one review seat, interrogate on sandbox, gates and handoff). The previous session recommended trimmed.
2. Grants for building: commits and pushes of feature branches, opening PRs, fixture issues, labels and comments in this repo, and changes on `pi-factorio`. Merging always stays with the owner.
3. Whether to firewall Plannotator's port 8001 to tailnet traffic only. It currently answers on the LAN IP too.

## Next action

Ask the owner the questions above if he has not answered them. On his go, start `F04a` (trusted `WORKFLOW.md` loader and `status --json`) per the plan, as a bare implementer in a worktree, then review its diff yourself before handing it to him.

## Also open in this session

- Plannotator is serving `docs/plans/factory-v1.md` on port 8001 at this machine's Tailscale name (`tailscale status --json | jq -r .Self.DNSName`), opened by `/plannotator-annotate`. The owner's annotations land in this session. Treat them as plan feedback.
- Dotfiles commit `70a5460` made Plannotator run in remote mode on the headless hosts. The owner's own uncommitted `.zshrc` and `config/pi/settings.json` edits in `~/dotfiles` are his; leave them alone. One `install.bats` test ("Linux check reports linux-headless agent-host state without mutation") failed, probably unrelated, not yet confirmed.

## Gotchas

- Send multi-line scripts to the VM with `ssh host bash -s < script`. Inline quoting through ssh and the hypa shell wrapper breaks.
- Never use backticks inside double-quoted shell strings in edits; they execute.
- `pkill -f <pattern>` can match the wrapper shell running it and kill your own command.
- When telling the owner a command, put it on its own line in a code block. A trailing period once broke `/plannotator-annotate`.
- `pi-herdr-agents` children only run inside Herdr. That is fine here, and on the VM Herdr runs headless.
- The factory may never edit anything under `.github/`, but the owner may authorize build PRs that add `.github/` files (`F04a`, `F07b`).
