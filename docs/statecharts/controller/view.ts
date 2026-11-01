import { state as journeyState, step as journeyStep } from "../journey/view.ts";

type State = Parameters<typeof journeyState>[0] & { mode: string };

export const title = "F09a durable controller (presentation subset)";

export const state = (v: State) => {
	if (v.mode === "down") return "Restart reconciles owned processes";

	if (v.mode === "missing")
		return "Missing private evidence blocks finalization";

	if (v.mode === "save")
		return "Claim write pending, no external effect authorized";

	if (v.mode === "promote_write")
		return "Expected predecessor read, non-force write pending";

	if (v.mode === "response")
		return "External launch occurred, response not yet durable";

	if (v.mode === "effect") return `Durable intent: ${v.b.pending}`;

	return journeyState(v);
};

export const group = (v: State) =>
	v.mode === "save" || v.mode === "down"
		? "persistence"
		: v.b.phase === "terminal"
			? "ended"
			: "active";

export const colors = { persistence: "orange", active: "teal", ended: "tan" };

const labels = {
	Decide: "shared candidate policy decides",
	ObserveTerminal: "observe merge or closure before pending work",
	Persist: "atomic claim write succeeds",
	LaunchProcess: "launch captured execution after durable intent",
	LaunchResponse: "record launch response",
	ProcessSettles: "execution settles, captured callback queues",
	Consume: "consume captured callback after PR observation",
	OpenRemote: "owned PR exists remotely, response may be lost",
	OtherResponse: "matching effect response",
	PublishValidation: "generation ref and fixed deadline recorded",
	StopProcess: "confirmed process stop",
	StopResponse: "usage reconciled after stop",
	ReadPredecessor: "read exact expected predecessor",
	WriteNonForce: "force:false update, not CAS",
	RefuseNonAncestor: "preserve unexpected owner head",
	Crash: "controller crashes, volatile callback queue is lost",
	RecoverStop: "stop owned orphan before reuse",
	Recover: "recover captured private intent",
	Cleanup: "delete only an owned retired validation ref",
	Expire: "original CI deadline expires",
};

export const step = (action: string) =>
	Object.entries(labels).find(([name]) => name === action)?.[1] ??
	journeyStep(action);
