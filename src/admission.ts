import { randomBytes } from "node:crypto";
import {
	type FileHandle,
	link,
	lstat,
	mkdir,
	open,
	readdir,
	unlink,
} from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	type Actor,
	actorText,
	type BodyHistory,
	type BodyVersion,
	DEFAULT_PAGING,
	type GitHubFailure,
	type GitHubPaging,
	GitHubTicketAdapter,
	isLogin,
	isTimestamp,
	issueUrl,
	type TimelineEntry,
} from "./adapters/github.ts";
import {
	hasWriteAccess,
	LOCAL_DISABLE_FILE,
	type PermissionLevel,
	parsePermissionLevel,
	READY_LABEL,
	REPO_SWITCH_LABEL,
	type WritePermission,
} from "./policy.ts";
import { type Digest, digestOf, isDigest, type NonEmpty } from "./run.ts";
import type { JsonValue } from "./tickets.ts";
import {
	type EnvLookup,
	type Exec,
	type GitSha,
	isGitSha,
	isRepoSlug,
	loadWorkflow,
	type RepoSlug,
	TRUSTED_REF,
	type WorkflowError,
	type WorkflowLoad,
} from "./workflow.ts";

/** The repositories this controller admits tickets from. */
export const FACTORY_REPOSITORIES: readonly RepoSlug[] = [
	"giuseppecrj/pi-herdr-factorio",
].filter(isRepoSlug);

export type Ambiguity =
	| "label_events_same_second"
	| "renamed_since_label"
	| "rename_history_incomplete"
	| "title_changed_between_reads"
	| "body_changed_between_reads"
	| "edited_at_label_time"
	| "history_contradicts_last_edit"
	| "history_incomplete"
	| "history_without_original"
	| "history_disagrees_with_body"
	| "no_version_before_label"
	| "version_withheld"
	| "answer_at_label_time";

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
	| {
			readonly kind: "unauthorized";
			readonly permission: Exclude<PermissionLevel, WritePermission>;
	  }
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
	readonly actorPermission: WritePermission;
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

/** The admission record for one label event, read back after a restart. */
export type RecordRead =
	| { readonly kind: "found"; readonly receipt: AdmittedReceipt }
	| { readonly kind: "absent" }
	| { readonly kind: "unreadable" };

export type SnapshotRead =
	| {
			readonly kind: "found";
			readonly receipt: AdmittedReceipt;
			readonly snapshot: IssueSnapshot;
	  }
	| { readonly kind: "absent" }
	| { readonly kind: "unreadable" };

export type RecordKey = {
	readonly repo: RepoSlug;
	readonly issue: number;
	readonly eventId: string;
};

export interface AdmissionStore {
	localSwitch(): Promise<LocalSwitch>;
	/** Records an admission once per label event. */
	record(
		receipt: AdmittedReceipt,
		snapshot: IssueSnapshot,
	): Promise<RecordOutcome>;
	read(key: RecordKey): Promise<RecordRead>;
	/** The label event IDs that have a record for one issue, or `null` when they cannot be listed. */
	listEvents(
		key: Omit<RecordKey, "eventId">,
	): Promise<readonly string[] | null>;
}

export interface SnapshotReader {
	/** The receipt and the snapshot text. A snapshot whose digest differs is `unreadable`. */
	readSnapshot(key: RecordKey): Promise<SnapshotRead>;
}

/**
 * The reads a polling tick makes once for every candidate: the repository
 * switch and the trusted workflow on `main`.
 */
export type TickReads = {
	readonly repoSwitch: RefusalReason | null;
	readonly workflow: WorkflowLoad;
};

const EVENT_ID = /^[1-9][0-9]{0,19}$/;

export function snapshotDigest(snapshot: IssueSnapshot): Digest {
	return digestOf(JSON.stringify([snapshot.title, snapshot.body]));
}

/**
 * Binds a label applied at `labelAt` to the title and body of that moment.
 * GitHub times have one-second precision, so an edit or rename in the same
 * second as the label is ambiguous. The title and its renames come from the
 * same response as the body history; `issueTitle` and `issueBody` come from
 * the earlier issue read, and must still match. The current body is used as
 * the label-time body only when the history agrees with it.
 */
export function labelTimeSnapshot(input: {
	history: BodyHistory;
	labelAt: string;
	renamedSinceLabel: boolean;
	issueTitle: string;
	issueBody: string;
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

	if (
		history.title !== input.issueTitle ||
		(history.renamedTo !== null && history.renamedTo !== history.title)
	) {
		return ambiguous("title_changed_between_reads");
	}

	if (history.body !== input.issueBody) {
		return ambiguous("body_changed_between_reads");
	}

	const { lastEditedAt, versions } = history;

	if (lastEditedAt === null || lastEditedAt < labelAt) {
		const editedAt = versions.map((version) => version.editedAt);

		if (editedAt.includes(labelAt)) return ambiguous("edited_at_label_time");

		const originals = history.includesCreatedEdit ? 1 : 0;
		const count = Math.max(history.totalVersions, editedAt.length);

		if (
			editedAt.some((at) => at > labelAt) ||
			(lastEditedAt === null
				? count > originals
				: editedAt.some((at) => at > lastEditedAt))
		) {
			return ambiguous("history_contradicts_last_edit");
		}

		if (history.totalVersions !== versions.length) {
			return ambiguous("history_incomplete");
		}

		if (lastEditedAt === null) {
			if (versions.some((version) => version.deleted)) {
				return ambiguous("version_withheld");
			}

			if (versions.some((version) => version.text !== history.body)) {
				return ambiguous("history_disagrees_with_body");
			}
		} else {
			const latest = versionInForce(versions, labelAt);

			if (latest === "withheld") return ambiguous("version_withheld");

			if (latest === "none" || latest.text !== history.body) {
				return ambiguous("history_disagrees_with_body");
			}
		}

		return {
			kind: "proved",
			source: "unedited",
			snapshot: { title: history.title, body: history.body },
		};
	}

	if (history.totalVersions !== versions.length) {
		return ambiguous("history_incomplete");
	}

	if (!history.includesCreatedEdit)
		return ambiguous("history_without_original");

	const [newest] = versions;

	if (newest?.text !== history.body || newest.editedAt !== lastEditedAt) {
		return ambiguous("history_disagrees_with_body");
	}

	if (versions.some((version) => version.editedAt === labelAt)) {
		return ambiguous("edited_at_label_time");
	}

	const version = versionInForce(versions, labelAt);

	if (version === "none") return ambiguous("no_version_before_label");

	if (version === "withheld") return ambiguous("version_withheld");

	return {
		kind: "proved",
		source: "edit_history",
		snapshot: { title: history.title, body: version.text },
	};
}

function versionInForce(
	versions: readonly BodyVersion[],
	at: string,
): BodyVersion | "none" | "withheld" {
	let latest: BodyVersion | null = null;
	let tied = false;

	for (const version of versions) {
		if (version.editedAt >= at) continue;

		if (latest === null || version.editedAt > latest.editedAt) {
			latest = version;
			tied = false;
		} else if (version.editedAt === latest.editedAt) {
			tied = true;
		}
	}

	if (latest === null) return "none";

	return tied || latest.deleted ? "withheld" : latest;
}

function fieldOf(
	value: JsonValue | undefined,
	key: string,
): JsonValue | undefined {
	if (
		value === undefined ||
		value === null ||
		Array.isArray(value) ||
		!(value instanceof Object)
	) {
		return undefined;
	}

	return Object.hasOwn(value, key) ? value[key] : undefined;
}

function textField(value: JsonValue | undefined, key: string): string | null {
	const field = fieldOf(value, key);
	const text = String(field);

	return field === text ? text : null;
}

/** Parses a stored record's receipt and checks that it names `key`. */
export function parseRecord(
	value: JsonValue | undefined,
	key: RecordKey,
): AdmittedReceipt | null {
	const receipt = fieldOf(value, "receipt");
	const reasons = fieldOf(receipt, "reasons");
	const permission = textField(receipt, "actorPermission");
	const level = permission === null ? null : parsePermissionLevel(permission);
	const eventAt = textField(receipt, "eventAt");
	const actor = textField(receipt, "actor");
	const digest = textField(receipt, "snapshotDigest");
	const source = textField(receipt, "snapshotSource");
	const baseSha = textField(receipt, "baseSha");
	const workflowDigest = textField(receipt, "workflowDigest");

	if (
		textField(receipt, "decision") !== "admitted" ||
		!Array.isArray(reasons) ||
		reasons.length !== 0 ||
		textField(receipt, "repo") !== key.repo ||
		fieldOf(receipt, "issue") !== key.issue ||
		textField(receipt, "issueUrl") !== issueUrl(key.repo, key.issue) ||
		textField(receipt, "eventId") !== key.eventId ||
		eventAt === null ||
		!isTimestamp(eventAt) ||
		actor === null ||
		!isLogin(actor) ||
		level === null ||
		!hasWriteAccess(level) ||
		digest === null ||
		!isDigest(digest) ||
		(source !== "unedited" && source !== "edit_history") ||
		baseSha === null ||
		!isGitSha(baseSha) ||
		workflowDigest === null ||
		!isDigest(workflowDigest)
	) {
		return null;
	}

	return {
		decision: "admitted",
		repo: key.repo,
		issue: key.issue,
		issueUrl: issueUrl(key.repo, key.issue),
		reasons: [],
		eventId: key.eventId,
		eventAt,
		actor,
		actorPermission: level,
		snapshotDigest: digest,
		snapshotSource: source,
		baseSha,
		workflowDigest,
	};
}

function errorCode(error: Error): string | null {
	return "code" in error && error.code === String(error.code)
		? error.code
		: null;
}

async function lstatCode(path: string): Promise<string | null> {
	try {
		await lstat(path);

		return null;
	} catch (error) {
		return (error instanceof Error ? errorCode(error) : null) ?? "unknown";
	}
}

async function isPrivateDirectory(path: string): Promise<boolean> {
	try {
		const info = await lstat(path);

		return (
			info.isDirectory() &&
			info.uid === process.geteuid?.() &&
			(info.mode & 0o022) === 0
		);
	} catch {
		return false;
	}
}

/**
 * Keeps the local kill switch and admission records under `stateDir`, which
 * must already exist as a real directory owned by this user and writable by
 * no one else. Any entry named `<stateDir>/disabled`, even a dangling
 * symlink, stops admission. Each admission is written once to
 * `<stateDir>/admissions/github/<owner>/<name>/<issue>/<event-id>.json` with
 * mode 0600, together with the snapshot text. The record is written to a
 * temporary file and linked into place, so it is never seen half-written.
 */
export function fileAdmissionStore(
	stateDir: string,
): AdmissionStore & SnapshotReader {
	const root = resolve(stateDir);

	const recordDir = (repo: RepoSlug, issue: number) => {
		const [owner = "", name = ""] = repo.split("/");

		return join(root, "admissions", "github", owner, name, String(issue));
	};

	const readStored = async (
		key: RecordKey,
	): Promise<
		| { readonly kind: "found"; readonly value: JsonValue | undefined }
		| { readonly kind: "absent" }
		| { readonly kind: "unreadable" }
	> => {
		if (!EVENT_ID.test(key.eventId)) return { kind: "unreadable" };

		let text: string;

		try {
			text = await readFile(
				join(recordDir(key.repo, key.issue), `${key.eventId}.json`),
				"utf8",
			);
		} catch (error) {
			const code = error instanceof Error ? errorCode(error) : null;

			return code === "ENOENT" ? { kind: "absent" } : { kind: "unreadable" };
		}

		let parsed: JsonValue | undefined;

		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = undefined;
		}

		return { kind: "found", value: parsed };
	};

	return {
		async localSwitch() {
			if (!(await isPrivateDirectory(root))) return "unavailable";

			const code = await lstatCode(join(root, LOCAL_DISABLE_FILE));

			if (code === null) return "disabled";

			return code === "ENOENT" ? "enabled" : "unavailable";
		},

		async read(key) {
			const stored = await readStored(key);

			if (stored.kind !== "found") return stored;

			const receipt = parseRecord(stored.value, key);

			return receipt === null
				? { kind: "unreadable" }
				: { kind: "found", receipt };
		},

		async readSnapshot(key) {
			const stored = await readStored(key);

			if (stored.kind !== "found") return stored;

			const receipt = parseRecord(stored.value, key);
			const snapshot = fieldOf(stored.value, "snapshot");
			const title = textField(snapshot, "title");
			const body = textField(snapshot, "body");

			if (receipt === null || title === null || body === null) {
				return { kind: "unreadable" };
			}

			return snapshotDigest({ title, body }) === receipt.snapshotDigest
				? { kind: "found", receipt, snapshot: { title, body } }
				: { kind: "unreadable" };
		},

		async listEvents(key) {
			let names: string[];

			try {
				names = await readdir(recordDir(key.repo, key.issue));
			} catch (error) {
				const code = error instanceof Error ? errorCode(error) : null;

				return code === "ENOENT" ? [] : null;
			}

			return names.flatMap((name) => {
				const eventId = name.slice(0, -".json".length);

				return name.endsWith(".json") && EVENT_ID.test(eventId)
					? [eventId]
					: [];
			});
		},

		async record(receipt, snapshot) {
			const dir = recordDir(receipt.repo, receipt.issue);

			const text = `${JSON.stringify({ receipt, snapshot }, null, 2)}\n`;
			const final = join(dir, `${receipt.eventId}.json`);

			const temp = join(
				dir,
				`.${receipt.eventId}.${randomBytes(8).toString("hex")}.tmp`,
			);

			let handle: FileHandle;

			try {
				await mkdir(dir, { recursive: true, mode: 0o700 });
				handle = await open(temp, "wx", 0o600);
			} catch {
				return "unwritable";
			}

			try {
				try {
					await handle.writeFile(text);
					await handle.sync();
				} finally {
					await handle.close();
				}

				return await linkRecord(temp, final);
			} catch {
				return "unwritable";
			} finally {
				await unlink(temp).catch(() => undefined);
			}
		},
	};
}

async function linkRecord(temp: string, final: string): Promise<RecordOutcome> {
	try {
		await link(temp, final);

		return "recorded";
	} catch (error) {
		const code = error instanceof Error ? errorCode(error) : null;

		return code === "EEXIST" ? "duplicate" : "unwritable";
	}
}

type Bound = {
	readonly eventId: string;
	readonly eventAt: string;
	readonly actor: string;
	readonly actorPermission: WritePermission;
	readonly snapshot: IssueSnapshot;
	readonly snapshotDigest: Digest;
	readonly snapshotSource: SnapshotSource;
	readonly baseSha: GitSha;
	readonly workflowDigest: Digest;
};

type Evaluation =
	| { readonly kind: "bound"; readonly bound: Bound }
	| { readonly kind: "refused"; readonly reason: RefusalReason };

export async function repoSwitchReason(
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

export type LatestReady =
	| { readonly kind: "none" }
	| { readonly kind: "tied" }
	| { readonly kind: "found"; readonly entry: ReadyEntry };

export function latestReadyEntry(
	timeline: readonly TimelineEntry[],
): LatestReady {
	const ready = timeline.filter(
		(entry): entry is ReadyEntry =>
			(entry.kind === "labeled" || entry.kind === "unlabeled") &&
			entry.label === READY_LABEL,
	);

	let latest: ReadyEntry | null = null;

	for (const entry of ready) {
		if (latest === null || entry.at > latest.at) latest = entry;
	}

	if (latest === null) return { kind: "none" };

	const latestAt = latest.at;

	return ready.filter((entry) => entry.at === latestAt).length > 1
		? { kind: "tied" }
		: { kind: "found", entry: latest };
}

async function evaluate(input: {
	workflow: WorkflowLoad;
	adapter: GitHubTicketAdapter;
	issue: number;
	evidence: Evidence;
}): Promise<Evaluation> {
	const { adapter, issue, evidence, workflow } = input;

	const refuse = (reason: RefusalReason): Evaluation => ({
		kind: "refused",
		reason,
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

	const latest = latestReadyEntry(timeline.value);

	if (latest.kind === "none") return refuse({ kind: "no_label_event" });

	if (latest.kind === "tied") {
		return refuse({
			kind: "ambiguous_snapshot",
			detail: "label_events_same_second",
		});
	}

	const event = latest.entry;

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

	const actorPermission = permission.value;

	evidence.actorPermission = actorPermission;

	if (!hasWriteAccess(actorPermission)) {
		return refuse({ kind: "unauthorized", permission: actorPermission });
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
		issueBody: record.value.body,
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
			actorPermission,
			snapshot: proof.snapshot,
			snapshotDigest: digest,
			snapshotSource: proof.source,
			baseSha,
			workflowDigest,
		},
	};
}

/** Reads the repository switch and the trusted workflow once. */
export async function readTickInputs(input: {
	exec: Exec;
	env: EnvLookup;
	adapter: GitHubTicketAdapter;
}): Promise<TickReads> {
	const repoSwitch = await repoSwitchReason(input.adapter);

	const workflow = await loadWorkflow({
		exec: input.exec,
		repo: input.adapter.repo,
		ref: TRUSTED_REF,
		env: input.env,
	});

	return { repoSwitch, workflow };
}

/**
 * Admits one issue when its latest `factory:ready` label event came from an
 * account with write access, both kill switches are on, and the label-time
 * title and body are proved. It only reads GitHub, writes the admission
 * record, and never starts a model. With the repository switch off or
 * unreadable it still evaluates the issue, so the refusal receipt shows as
 * much of the event and snapshot as that evaluation reached. The evaluation
 * stops at its first refusal, such as a workflow that does not load, which
 * comes before any issue read. A polling tick passes `tick`, the reads it
 * already made, so each candidate costs only its issue reads.
 */
export async function admitTicket(input: {
	exec: Exec;
	env: EnvLookup;
	repo: RepoSlug;
	issue: number;
	allowlist: readonly RepoSlug[];
	store: AdmissionStore;
	paging?: GitHubPaging;
	tick?: TickReads;
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

	const reads =
		input.tick ??
		(await readTickInputs({ exec: input.exec, env: input.env, adapter }));

	const switchReason = reads.repoSwitch;

	const evaluation = await evaluate({
		workflow: reads.workflow,
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
