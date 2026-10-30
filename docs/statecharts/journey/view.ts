const STAGE: Record<string, string> = {
  admit: "Checking the labeler",
  specify: "Writing the contract",
  accept: "Writing hidden acceptance tests",
  build: "Building the patch",
  validate: "CI runs main's gates and the hidden tests",
  review: "Reviewing the patch",
  land: "PR waits for your review",
};

const END: Record<string, string> = {
  landed: "Merged, issue closed",
  needs_info: "Waiting for your answer",
  rejected: "Rejected",
  failed: "Failed",
  budget: "Stopped",
  cancelled: "Stopped",
};

export const title = "A ticket's journey through the factory (v1 design)";

export const state = (v: any) => {
  if (v.phase === "admit") return [STAGE.admit];
  if (v.phase in STAGE) {
    if (v.merged) return ["Run in progress", "Still working on a PR you already merged"];
    return ["Run in progress", STAGE[v.phase]];
  }
  return [END[v.phase]];
};

export const group = (v: any) => {
  if (v.phase === "admit") return "built";
  if (v.phase === "specify") return "partly";
  if (v.phase in STAGE) return "planned";
  return v.phase === "landed" || v.phase === "needs_info" ? "planned" : "end";
};

export const colors = {
  built: "teal",
  partly: "yellow",
  planned: "purple",
  end: "tan",
};

const rounds = (from: any) =>
  from.repairs >= 2 ? "[2 repair rounds used]" : "[under 2 repair rounds used]";

export const step = (action: string, from: any, _to: any) => {
  switch (action) {
    case "Admitted":
      return "admitted, issue text frozen";
    case "AdmitRefuses":
      return "the labeler lacks write access";
    case "Specified":
      return "contract written";
    case "TooVague":
      return "ticket too vague, questions posted";
    case "Accepted":
      return "hidden tests kept on the VM";
    case "Built":
      return "patch ready";
    case "ChecksPass":
      return "every check passes on that exact patch";
    case "ChecksFail":
      return `a check fails ${rounds(from)}`;
    case "ReviewClean":
      return "no blocking findings, PR marked ready";
    case "ReviewBlocks":
      return `blocking findings ${rounds(from)}`;
    case "YouComment":
      return `you comment on the PR ${rounds(from)}`;
    case "YouMerge":
      return from.phase === "land" || from.phase === "build"
        ? "you merge the PR"
        : null;
    case "YouClosePR":
      return from.phase === "land" ? "you close the PR without merging" : null;
    case "StageFails":
      return "a stage keeps failing";
    case "BudgetSpent":
      return "token budget spent";
    case "PolicyStops":
      return "policy refuses, or the patch touches a forbidden path";
    case "LabelRemoved":
      return "label removed or issue closed";
    case "Done":
      return null;
  }
  return action;
};
