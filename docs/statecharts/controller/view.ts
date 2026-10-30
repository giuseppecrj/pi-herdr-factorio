const ENDED: Record<string, string> = {
  stage_passed: "Stage passed, run stops here for now",
  failed: "Failed",
  budget_exhausted: "Token budget spent",
  released: "Released",
};

const HELD: Record<string, string> = {
  claimed: "Claimed, marker posted on the issue",
  running: "Stage running in the sandbox",
  blocked: "Sandbox down, slot kept",
  retry: "Waiting to retry",
};

export const title = "What the controller does with one run today";

export const state = (v: any) => {
  if (!v.loaded) return ["Controller restarting"];
  if (v.ph in HELD) return ["Holding a claim", HELD[v.ph]];
  if (v.ph === "ending") return ["Stopping the aborted stage"];
  const last = v.marker[v.event];
  if (last in ENDED) return [ENDED[last]];
  if (v.ticket === "gone") return ["Label removed, nothing running"];
  return ["Seen with the ready label"];
};

export const group = (v: any) => {
  if (!v.loaded) return "restart";
  if (v.ph in HELD) return "held";
  if (v.ph === "ending") return "held";
  return v.marker[v.event] in ENDED ? "ended" : "waiting";
};

export const colors = {
  waiting: "blue",
  held: "teal",
  restart: "orange",
  ended: "tan",
};

export const step = (action: string, from: any, to: any) => {
  switch (action) {
    case "Admit":
      return "admitted";
    case "Launch":
      if (to.ph === "blocked") return "the sandbox check fails";
      if (to.ph === "running")
        return from.ph === "retry" ? "backoff ends" : "the sandbox launches the stage";
      return "launch refused, token cap reached";
    case "StagePasses":
      return "stage passes";
    case "StageRefuses":
      return "stage refuses";
    case "StageFails":
    case "StageStalls":
      if (to.ph === "retry") return "stage fails or stalls [attempts and tokens left]";
      if (to.ph === "ending") return "stage stalls [no attempts or tokens left]";
      return to.marker[from.run] === "failed"
        ? "stage fails [no attempts left]"
        : "stage fails [token cap reached]";
    case "Release":
      return "label removed or issue closed";
    case "PostEnd":
    case "SandboxStops":
      return "the aborted sandbox stops";
    case "Restart":
      return from.ph === "none" ? null : "the controller restarts";
    case "Recover": {
      if (to.ph !== "none") return "first tick recovers the run from its marker";
      const last = to.marker[to.event];
      if (last === "released") return "first tick finds the label gone";
      if (last === "failed") return "first tick ends the interrupted attempt [no attempts left]";
      return null;
    }
    case "Reconcile":
      return null;
    case "YouRemoveLabel":
      return "label removed or issue closed";
    case "YouRelabel":
      return "you re-label the issue";
    case "SandboxBreaks":
      return "the sandbox check starts failing";
    case "SandboxHeals":
      return "the sandbox check passes";
    case "Idle":
      return null;
  }
  return action;
};
