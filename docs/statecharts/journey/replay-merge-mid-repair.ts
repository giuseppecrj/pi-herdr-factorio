// Replays the MergeEndsRun path from Journey.tla against src/stages.ts advance().
// Run from the repo root: node --experimental-strip-types docs/statecharts/journey/replay-merge-mid-repair.ts
import { advance } from "../../../src/stages.ts";
const digest = (c: string) => `sha256:${c.repeat(64)}` as any;
let run: any = { id: "r", ticket: { kind: "github", repo: "o/r", number: 1 }, repo: "o/r", baseSha: "a".repeat(40), repairRounds: 0, progress: { kind: "active", stage: "admit" } };
const step = (e: any) => { const t = advance(run, e); console.log(e.kind.padEnd(10), "->", t.kind === "advanced" ? JSON.stringify(t.run.progress) : `invalid: ${t.reason}`); if (t.kind === "advanced") run = t.run; };
step({ kind: "admitted" });
step({ kind: "specified", contractDigest: digest("1") });
step({ kind: "accepted", acceptanceDigest: digest("2") });
step({ kind: "built", patchDigest: digest("3") });
step({ kind: "validated", verdict: { patchDigest: digest("3"), pass: true, checks: [{ name: "ci", passed: true }] } });
step({ kind: "reviewed", blockingFindings: [] });
// Owner comments on the PR (F10, not built): stand in with a blocking review, which takes the same repairOrFail path back to build.
console.log("-- owner feedback round (F10 stand-in: blocking findings at review) --");
// back to review with the same verified patch, as the PR sits in review
run = { ...run, progress: { kind: "active", stage: "review" } }; step({ kind: "reviewed", blockingFindings: ["owner comment"] });
console.log("-- owner merges the PR on GitHub while the repair is building --");
step({ kind: "landed", mergeSha: "b".repeat(40) });
console.log("run still:", JSON.stringify(run.progress));
