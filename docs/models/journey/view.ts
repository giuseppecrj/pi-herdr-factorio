type Book = {
	phase: string;
	pending: string;
	terminal: string;
	assurance: string;
};

type State = { b: Book };

export const title = "F09a candidate journey (presentation subset)";

const phases = {
	admit: "Checking authorization",
	specify: "Writing the contract",
	accept: "Writing acceptance tests",
	build: "Building the initial patch",
	validate: "Publishing and checking the exact candidate",
	review_due: "Fresh review due",
	reviewing: "Reviewing captured source and pin",
	repair_due: "Pre-PR repair due",
	repairing: "Building a sanitized repair",
	repair_built: "Repair settled, selection due",
	handoff: "Certified candidate, handoff incomplete",
	waiting: "Ready PR waits for the owner, no model slot",
	held: "PR held, historical certificate retained",
	finishing: "Merge observed, stop and account before finish",
};

export const state = ({ b }: State) => {
	if (b.phase === "terminal")
		return b.terminal === "merged"
			? `Issue closed (${b.assurance})`
			: "Run ended without merge";

	if (b.pending === "stop_execution") return "Stopping captured execution";

	if (b.pending === "finish_pr")
		return "Known settlement, terminal bookkeeping due";

	return (
		Object.entries(phases).find(([phase]) => phase === b.phase)?.[1] ?? b.phase
	);
};

export const group = ({ b }: State) =>
	b.phase === "terminal"
		? "ended"
		: b.phase === "waiting"
			? "waiting"
			: "active";

export const colors = { active: "teal", waiting: "blue", ended: "tan" };

const actions = {
	Early: "next trusted stage",
	EarlyRetry: "bounded early retry",
	Validate: "exact CI result collected",
	ReviewDue: "issue next round-global review",
	Launch: "captured execution starts",
	SettleReview: "review and usage settle",
	Handoff: "reconcile exact head and checks",
	RemoteOpen: "owned PR created (response may be lost)",
	Open: "owned PR identity saved",
	OrdinaryPass: "ordinary check passes on current PR head",
	CompleteHandoff: "mark ready after exact check",
	OwnerMerge: "owner merges on GitHub",
	ObserveMerge: "observe actual merged head and merge SHA",
	Stop: "confirmed stop, usage reconciled",
	FinishPr: "terminal bookkeeping succeeds",
	RemotePromote: "non-force update, not CAS",
	Promote: "reread ref and PR head",
	Refresh: "main movement selects fresh generation or holds",
	HeadConverges: "PR head catches up to ref",
};

export const step = (action: string) =>
	Object.entries(actions).find(([name]) => name === action)?.[1] ?? action;
