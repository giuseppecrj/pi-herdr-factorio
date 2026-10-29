import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type Actor,
	actorText,
	type BodyHistory,
	DEFAULT_PAGING,
	type GitHubFailure,
	type GitHubPaging,
	GitHubTicketAdapter,
	issueUrl,
	type TimelineEntry,
} from "./adapters/github.ts";
import {
	decideAdmission,
	LOCAL_DISABLE_FILE,
	type PermissionLevel,
	READY_LABEL,
	REPO_SWITCH_LABEL,
} from "./policy.ts";
import { type Digest, digestOf, type NonEmpty } from "./run.ts";
import {
	type EnvLookup,
	type Exec,
	type GitSha,
	isRepoSlug,
	loadWorkflow,
	type RepoSlug,
	TRUSTED_REF,
	type WorkflowError,
} from "./workflow.ts";

/** The repositories this controller admits tickets from. */
export const FACTORY_REPOSITORIES: readonly RepoSlug[] = [
	"giuseppecrj/pi-herdr-factorio",
].filter(isRepoSlug);

export type Ambiguity =
	| "renamed_since_label"
	| "rename_history_incomplete"
	| "title_changed_between_reads"
	| "edited_at_label_time"
	| "history_incomplete"
	| "history_without_original"
	| "history_disagrees_with_body"
	| "no_version_before_label"
	| "version_withheld";

export type RefusalReason =
	| { readonly kind: "repo_not_allowed" }
	| { readonly kind: "state_unavailable" }
	| { readonly kind: "locally_disabled" }
	| { readonly kind: "repo_switch_off" }
	| {
			readonly kind:
				| "repo_switch_unavailable"
				| "issue_unavailable"
				| "timeline_unavailable"
				| "permission_unavailable"
				| "snapshot_unavailable";
			readonly failure: GitHubFailure;
	  }
	| {
			readonly kind: "workflow_unavailable";
			readonly error: WorkflowError["kind"];
	  }
	| { readonly kind: "issue_closed" }
	| { readonly kind: "pull_request" }
	| { readonly kind: "not_labeled" }
	| { readonly kind: "no_label_event" }
	| { readonly kind: "actor_withheld" }
	| { readonly kind: "unauthorized"; readonly permission: PermissionLevel }
	| { readonly kind: "ambiguous_snapshot"; readonly detail: Ambiguity }
	| { readonly kind: "duplicate_event" }
	| { readonly kind: "state_unwritable" };

export type SnapshotSource = "unedited" | "edit_history";

/** The issue as it was when the ready label was applied. Untrusted text. */
export type IssueSnapshot = { readonly title: string; readonly body: string };

export type SnapshotProof =
	| {
			readonly kind: "proved";
			readonly source: SnapshotSource;
			readonly snapshot: IssueSnapshot;
	  }
	| { readonly kind: "ambiguous"; readonly detail: Ambiguity };

type ReceiptHeader = {
	readonly repo: RepoSlug;
	readonly issue: number;
	readonly issueUrl: string;
};

export type AdmittedReceipt = ReceiptHeader & {
	readonly decision: "admitted";
	readonly reasons: readonly [];
	readonly eventId: string;
	readonly eventAt: string;
	readonly actor: string;
	readonly actorPermission: PermissionLevel;
	readonly snapshotDigest: Digest;
	readonly snapshotSource: SnapshotSource;
	readonly baseSha: GitSha;
	readonly workflowDigest: Digest;
};

type Evidence = {
	eventId: string | null;
	eventAt: string | null;
	actor: string | null;
	actorPermission: PermissionLevel | null;
	snapshotDigest: Digest | null;
	snapshotSource: SnapshotSource | null;
	baseSha: GitSha | null;
	workflowDigest: Digest | null;
};

export type RefusedReceipt = ReceiptHeader &
	Readonly<Evidence> & {
		readonly decision: "refused";
		readonly reasons: NonEmpty<RefusalReason>;
	};

/** Never carries issue text. Logins are printed only when they pass GitHub's grammar. */
export type AdmissionReceipt = AdmittedReceipt | RefusedReceipt;

export type LocalSwitch = "enabled" | "disabled" | "unavailable";

export type RecordOutcome = "recorded" | "duplicate" | "unwritable";

export interface AdmissionStore {
	localSwitch(): Promise<LocalSwitch>;
	/** Records an admission once per label event. */
	record(
		receipt: AdmittedReceipt,
		snapshot: IssueSnapshot,
	): Promise<RecordOutcome>;
}

export function snapshotDigest(snapshot: IssueSnapshot): Digest {
	return digestOf(JSON.stringify([snapshot.title, snapshot.body]));
}

/**
 * Binds a label applied at `labelAt` to the title and body of that moment.
 * GitHub times have one-second precision, so an edit or rename in the same
 * second as the label is ambiguous. The title and its renames come from the
 * same response as the body history; `issueTitle` is the title of the earlier
 * issue read, which must still match.
 */
export function labelTimeSnapshot(input: {
	history: BodyHistory;
	labelAt: string;
	renamedSinceLabel: boolean;
	issueTitle: string;
}): SnapshotProof {
	const { history, labelAt } = input;

	const ambiguous = (detail: Ambiguity): SnapshotProof => ({
		kind: "ambiguous",
		detail,
	});

	if (input.renamedSinceLabel) return ambiguous("renamed_since_label");

	if (history.totalRenames !== history.renamedAt.length) {
		return ambiguous("rename_history_incomplete");
	}

	if (history.renamedAt.some((at) => at >= labelAt)) {
		return ambiguous("renamed_since_label");
	}

	if (history.title !== input.issueTitle) {
		return ambiguous("title_changed_between_reads");
	}

	if (history.lastEditedAt === null || history.lastEditedAt < labelAt) {
		return {
			kind: "proved",
			source: "unedited",
			snapshot: { title: history.title, body: history.body },
		};
	}

	const { versions } = history;

	if (history.totalVersions !== versions.length) {
		return ambiguous("history_incomplete");
	}

	if (!history.includesCreatedEdit)
		return ambiguous("history_without_original");

	const [newest] = versions;

	if (
		newest?.text !== history.body ||
		newest.editedAt !== history.lastEditedAt
	) {
		return ambiguous("history_disagrees_with_body");
	}

	if (versions.some((version) => version.editedAt === labelAt)) {
		return ambiguous("edited_at_label_time");
	}

	let latestAt = "";

	for (const { editedAt } of versions) {
		if (editedAt < labelAt && editedAt > latestAt) latestAt = editedAt;
	}

	if (latestAt === "") return ambiguous("no_version_before_label");

	const inForce = versions.filter((version) => version.editedAt === latestAt);
	const [version] = inForce;

	if (
		inForce.length !== 1 ||
		version === undefined ||
		version.deleted ||
		version.text === null
	) {
		return ambiguous("version_withheld");
	}

	return {
		kind: "proved",
		source: "edit_history",
		snapshot: { title: history.title, body: version.text },
	};
}

function errorCode(error: Error): string | null {
	return "code" in error && error.code === String(error.code)
		? error.code
		: null;
}

function codeOf(error: Error | null): string | null {
	return error === null ? null : errorCode(error);
}

async function statError(path: string): Promise<Error | null> {
	try {
		await stat(path);

		return null;
	} catch (error) {
		return error instanceof Error ? error : new Error("stat failed");
	}
}

/**
 * Keeps the local kill switch and admission records under `stateDir`, which
 * must already exist. `<stateDir>/disabled` stops admission. Each admission
 * is written once to `<stateDir>/admissions/github/<owner>/<name>/<issue>/<event-id>.json`
 * with mode 0600, together with the snapshot text.
 */
export function fileAdmissionStore(stateDir: string): AdmissionStore {
	return {
		async localSwitch() {
			let isDirectory: boolean;

			try {
				isDirectory = (await stat(stateDir)).isDirectory();
			} catch {
				return "unavailable";
			}

			if (!isDirectory) return "unavailable";

			const flag = await statError(join(stateDir, LOCAL_DISABLE_FILE));

			if (flag === null) return "disabled";

			return codeOf(flag) === "ENOENT" ? "enabled" : "unavailable";
		},

		async record(receipt, snapshot) {
			const [owner = "", name = ""] = receipt.repo.split("/");

			const dir = join(
				stateDir,
				"admissions",
				"github",
				owner,
				name,
				String(receipt.issue),
			);

			const text = `${JSON.stringify({ receipt, snapshot }, null, 2)}\n`;

			try {
				await mkdir(dir, { recursive: true, mode: 0o700 });

				await writeFile(join(dir, `${receipt.eventId}.json`), text, {
					flag: "wx",
					mode: 0o600,
				});

				return "recorded";
			} catch (error) {
				const code = error instanceof Error ? errorCode(error) : null;

				return code === "EEXIST" ? "duplicate" : "unwritable";
			}
		},
	};
}

type Bound = {
	readonly eventId: string;
	readonly eventAt: string;
	readonly actor: string;
	readonly actorPermission: PermissionLevel;
	readonly snapshot: IssueSnapshot;
	readonly snapshotDigest: Digest;
	readonly snapshotSource: SnapshotSource;
	readonly baseSha: GitSha;
	readonly workflowDigest: Digest;
};

type Evaluation =
	| { readonly kind: "bound"; readonly bound: Bound }
	| { readonly kind: "refused"; readonly reason: RefusalReason };

async function repoSwitchReason(
	adapter: GitHubTicketAdapter,
): Promise<RefusalReason | null> {
	const read = await adapter.readRepoSwitch();

	if (read.kind === "failed") {
		return { kind: "repo_switch_unavailable", failure: read.failure };
	}

	return read.value.kind === "present" && read.value.name === REPO_SWITCH_LABEL
		? null
		: { kind: "repo_switch_off" };
}

type ReadyEntry = Extract<TimelineEntry, { kind: "labeled" | "unlabeled" }>;

function lastReadyEntry(timeline: readonly TimelineEntry[]): ReadyEntry | null {
	let last: ReadyEntry | null = null;

	for (const entry of timeline) {
		if (
			(entry.kind === "labeled" || entry.kind === "unlabeled") &&
			entry.label === READY_LABEL
		) {
			last = entry;
		}
	}

	return last;
}

async function evaluate(input: {
	exec: Exec;
	env: EnvLookup;
	adapter: GitHubTicketAdapter;
	issue: number;
	evidence: Evidence;
}): Promise<Evaluation> {
	const { adapter, issue, evidence } = input;

	const refuse = (reason: RefusalReason): Evaluation => ({
		kind: "refused",
		reason,
	});

	const workflow = await loadWorkflow({
		exec: input.exec,
		repo: adapter.repo,
		ref: TRUSTED_REF,
		env: input.env,
	});

	if (workflow.kind === "failed") {
		return refuse({ kind: "workflow_unavailable", error: workflow.error.kind });
	}

	const baseSha = workflow.snapshot.sha;
	const workflowDigest = workflow.snapshot.digest;

	evidence.baseSha = baseSha;
	evidence.workflowDigest = workflowDigest;

	const record = await adapter.readIssue(issue);

	if (record.kind === "failed") {
		return refuse({ kind: "issue_unavailable", failure: record.failure });
	}

	if (record.value.pullRequest) return refuse({ kind: "pull_request" });

	if (!record.value.open) return refuse({ kind: "issue_closed" });

	if (!record.value.labels.includes(READY_LABEL)) {
		return refuse({ kind: "not_labeled" });
	}

	const timeline = await adapter.readTimeline(issue);

	if (timeline.kind === "failed") {
		return refuse({ kind: "timeline_unavailable", failure: timeline.failure });
	}

	const event = lastReadyEntry(timeline.value);

	if (event === null) return refuse({ kind: "no_label_event" });

	if (event.kind === "unlabeled") return refuse({ kind: "not_labeled" });

	evidence.eventId = event.id;
	evidence.eventAt = event.at;
	evidence.actor = actorText(event.actor);

	const actor: Actor = event.actor;

	if (actor.kind === "withheld") return refuse({ kind: "actor_withheld" });

	const permission = await adapter.readPermission(actor.login);

	if (permission.kind === "failed") {
		return refuse({
			kind: "permission_unavailable",
			failure: permission.failure,
		});
	}

	evidence.actorPermission = permission.value;

	const decision = decideAdmission({
		label: event.label,
		actorPermission: permission.value,
	});

	if (decision.kind === "refused") {
		return refuse(
			decision.reason === "unauthorized"
				? { kind: "unauthorized", permission: permission.value }
				: { kind: "not_labeled" },
		);
	}

	const history = await adapter.readBodyHistory(issue);

	if (history.kind === "failed") {
		return refuse({ kind: "snapshot_unavailable", failure: history.failure });
	}

	const proof = labelTimeSnapshot({
		history: history.value,
		labelAt: event.at,
		renamedSinceLabel: timeline.value.some(
			(entry) => entry.kind === "renamed" && entry.at >= event.at,
		),
		issueTitle: record.value.title,
	});

	if (proof.kind === "ambiguous") {
		return refuse({ kind: "ambiguous_snapshot", detail: proof.detail });
	}

	const digest = snapshotDigest(proof.snapshot);

	evidence.snapshotDigest = digest;
	evidence.snapshotSource = proof.source;

	return {
		kind: "bound",
		bound: {
			eventId: event.id,
			eventAt: event.at,
			actor: actor.login,
			actorPermission: permission.value,
			snapshot: proof.snapshot,
			snapshotDigest: digest,
			snapshotSource: proof.source,
			baseSha,
			workflowDigest,
		},
	};
}

/**
 * Admits one issue when its latest `factory:ready` label event came from an
 * account with write access, both kill switches are on, and the label-time
 * title and body are proved. It only reads GitHub, writes the admission
 * record, and never starts a model. With the repository switch off or
 * unreadable it still reads the issue, so the refusal receipt shows the
 * event and snapshot it would have bound.
 */
export async function admitTicket(input: {
	exec: Exec;
	env: EnvLookup;
	repo: RepoSlug;
	issue: number;
	allowlist: readonly RepoSlug[];
	store: AdmissionStore;
	paging?: GitHubPaging;
}): Promise<AdmissionReceipt> {
	const { repo, issue, store } = input;
	const header = { repo, issue, issueUrl: issueUrl(repo, issue) };

	const evidence: Evidence = {
		eventId: null,
		eventAt: null,
		actor: null,
		actorPermission: null,
		snapshotDigest: null,
		snapshotSource: null,
		baseSha: null,
		workflowDigest: null,
	};

	const refused = (reasons: NonEmpty<RefusalReason>): RefusedReceipt => ({
		decision: "refused",
		...header,
		reasons,
		...evidence,
	});

	if (!input.allowlist.includes(repo)) {
		return refused([{ kind: "repo_not_allowed" }]);
	}

	const local = await store.localSwitch();

	if (local === "unavailable") return refused([{ kind: "state_unavailable" }]);

	if (local === "disabled") return refused([{ kind: "locally_disabled" }]);

	const adapter = new GitHubTicketAdapter({
		exec: input.exec,
		repo,
		paging: input.paging ?? DEFAULT_PAGING,
	});

	const switchReason = await repoSwitchReason(adapter);

	const evaluation = await evaluate({
		exec: input.exec,
		env: input.env,
		adapter,
		issue,
		evidence,
	});

	if (evaluation.kind === "refused") {
		return refused(
			switchReason === null
				? [evaluation.reason]
				: [switchReason, evaluation.reason],
		);
	}

	if (switchReason !== null) return refused([switchReason]);

	const { snapshot, ...bound } = evaluation.bound;

	const receipt: AdmittedReceipt = {
		decision: "admitted",
		...header,
		reasons: [],
		...bound,
	};

	const outcome = await store.record(receipt, snapshot);

	if (outcome === "duplicate") return refused([{ kind: "duplicate_event" }]);

	if (outcome === "unwritable") return refused([{ kind: "state_unwritable" }]);

	return receipt;
}
