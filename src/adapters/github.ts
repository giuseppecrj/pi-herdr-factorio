import {
	hasWriteAccess,
	type PermissionLevel,
	parsePermissionLevel,
	READY_LABEL,
	REPO_SWITCH_LABEL,
} from "../policy.ts";
import type { TicketRef } from "../run.ts";
import {
	type FactoryEvent,
	type JsonValue,
	type Ticket,
	type TicketReader,
	type TicketState,
	ticketKey,
} from "../tickets.ts";
import type { Exec, ExecResult, GhCause, RepoSlug } from "../workflow.ts";

export type Login = string & { readonly __brand: "Login" };

/** A label actor or author: a login that passed GitHub's grammar, or not. */
export type Actor =
	| { readonly kind: "login"; readonly login: Login }
	| { readonly kind: "withheld" };

export type GitHubFailure =
	| {
			readonly kind: "gh_failed";
			readonly cause: GhCause;
			readonly status: number | null;
	  }
	| { readonly kind: "cannot_run_gh" }
	| { readonly kind: "malformed_response" }
	| { readonly kind: "pagination_limit" };

export type Read<T> =
	| { readonly kind: "ok"; readonly value: T }
	| { readonly kind: "failed"; readonly failure: GitHubFailure };

export type IssueRecord = {
	readonly number: number;
	readonly open: boolean;
	readonly pullRequest: boolean;
	readonly labels: readonly string[];
	readonly author: Actor;
	readonly title: string;
	readonly body: string;
};

export type TimelineEntry =
	| {
			readonly kind: "labeled" | "unlabeled";
			readonly id: string;
			readonly at: string;
			readonly actor: Actor;
			readonly label: string;
	  }
	| { readonly kind: "renamed"; readonly at: string }
	| { readonly kind: "other" };

export type BodyVersion = {
	readonly editedAt: string;
	readonly deleted: boolean;
	readonly text: string | null;
};

export type BodyHistory = {
	readonly title: string;
	readonly body: string;
	readonly lastEditedAt: string | null;
	readonly includesCreatedEdit: boolean;
	readonly totalVersions: number;
	/** Newest first, as GitHub returns them. */
	readonly versions: readonly BodyVersion[];
	readonly totalRenames: number;
	/** When each returned title rename happened, from the same response as `title`. */
	readonly renamedAt: readonly string[];
};

/** GitHub looks labels up case-insensitively, so `name` is the stored name. */
export type RepoSwitch =
	| { readonly kind: "present"; readonly name: string }
	| { readonly kind: "absent" };

export type GitHubPaging = {
	readonly pageSize: number;
	readonly maxPages: number;
};

export const DEFAULT_PAGING: GitHubPaging = { pageSize: 100, maxPages: 10 };

export const MAX_BODY_VERSIONS = 100;

export const MAX_TITLE_RENAMES = 100;

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:\[bot\])?$/;

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const NETWORK_FAILURE =
	/error connecting|could not resolve host|no such host|dial tcp|connection (?:refused|reset)|timed? ?out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|TLS handshake/i;

const BODY_HISTORY_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      title body lastEditedAt includesCreatedEdit
      userContentEdits(first: ${MAX_BODY_VERSIONS}) {
        totalCount
        nodes { editedAt deletedAt diff }
      }
      renames: timelineItems(itemTypes: [RENAMED_TITLE_EVENT], last: ${MAX_TITLE_RENAMES}) {
        totalCount
        nodes { ... on RenamedTitleEvent { createdAt previousTitle currentTitle } }
      }
    }
  }
}`;

export function isLogin(input: string): input is Login {
	return LOGIN.test(input);
}

export function isTimestamp(input: string): boolean {
	return TIMESTAMP.test(input);
}

/** The text the factory prints for an actor. */
export function actorText(actor: Actor): string {
	return actor.kind === "login" ? actor.login : "(withheld)";
}

export function issueUrl(repo: RepoSlug, issue: number): string {
	return `https://github.com/${repo}/issues/${issue}`;
}

type JsonObject = { readonly [key: string]: JsonValue };

function objectOf(value: JsonValue | undefined): JsonObject | null {
	if (
		value === undefined ||
		value === null ||
		value === true ||
		value === false ||
		Array.isArray(value)
	) {
		return null;
	}

	return value instanceof Object ? value : null;
}

function arrayOf(value: JsonValue | undefined): readonly JsonValue[] | null {
	return value !== undefined && Array.isArray(value) ? value : null;
}

function stringOf(value: JsonValue | undefined): string | null {
	if (value === undefined) return null;

	const text = String(value);

	return value === text ? text : null;
}

function booleanOf(value: JsonValue | undefined): boolean | null {
	return value === true || value === false ? value : null;
}

function countOf(value: JsonValue | undefined): number | null {
	if (value === undefined) return null;

	const count = Number(value);

	return value === count && Number.isSafeInteger(count) && count >= 0
		? count
		: null;
}

function fieldOf(object: JsonObject, key: string): JsonValue | undefined {
	return Object.hasOwn(object, key) ? object[key] : undefined;
}

function pathOf(value: JsonValue | undefined, keys: readonly string[]) {
	let current = value;

	for (const key of keys) {
		const object = objectOf(current);

		if (object === null) return undefined;
		current = fieldOf(object, key);
	}

	return current;
}

function timestampOf(value: JsonValue | undefined): string | null {
	const text = stringOf(value);

	return text !== null && isTimestamp(text) ? text : null;
}

function idOf(value: JsonValue | undefined): string | null {
	const id = countOf(value);

	return id === null || id === 0 ? null : String(id);
}

function actorOf(value: JsonValue | undefined): Actor {
	const login = stringOf(pathOf(value, ["login"]));

	return login !== null && isLogin(login)
		? { kind: "login", login }
		: { kind: "withheld" };
}

function parseJson(text: string): JsonValue | undefined {
	try {
		const parsed: JsonValue = JSON.parse(text);

		return parsed;
	} catch {
		return undefined;
	}
}

function ghFailure(result: ExecResult): GitHubFailure {
	const code = /\bHTTP (\d{3})\b/.exec(result.stderr)?.[1];
	const status = code === undefined ? null : Number(code);

	if (status === 404) return { kind: "gh_failed", cause: "not_found", status };

	if (status === 401 || status === 403) {
		return { kind: "gh_failed", cause: "auth", status };
	}

	if (status !== null) return { kind: "gh_failed", cause: "other", status };

	const cause = NETWORK_FAILURE.test(result.stderr) ? "network" : "other";

	return { kind: "gh_failed", cause, status: null };
}

function failed(failure: GitHubFailure): Read<never> {
	return { kind: "failed", failure };
}

const MALFORMED = failed({ kind: "malformed_response" });

function labelNamesOf(value: JsonValue | undefined): string[] | null {
	const labels = arrayOf(value);

	if (labels === null) return null;

	const names: string[] = [];

	for (const label of labels) {
		const name = stringOf(pathOf(label, ["name"]));

		if (name === null) return null;
		names.push(name);
	}

	return names;
}

function parseIssue(value: JsonValue | undefined): IssueRecord | null {
	const issue = objectOf(value);

	if (issue === null) return null;

	const number = countOf(fieldOf(issue, "number"));
	const state = stringOf(fieldOf(issue, "state"));
	const labels = labelNamesOf(fieldOf(issue, "labels"));
	const title = stringOf(fieldOf(issue, "title"));
	const body = fieldOf(issue, "body");
	const bodyText = body === null ? "" : stringOf(body);

	if (
		number === null ||
		(state !== "open" && state !== "closed") ||
		labels === null ||
		title === null ||
		bodyText === null
	) {
		return null;
	}

	return {
		number,
		open: state === "open",
		pullRequest: fieldOf(issue, "pull_request") !== undefined,
		labels,
		author: actorOf(fieldOf(issue, "user")),
		title,
		body: bodyText,
	};
}

function parseTimelineEntry(value: JsonValue): TimelineEntry | null {
	const entry = objectOf(value);

	if (entry === null) return null;

	const event = stringOf(fieldOf(entry, "event"));

	if (event === "renamed") {
		const at = timestampOf(fieldOf(entry, "created_at"));

		return at === null ? null : { kind: "renamed", at };
	}

	if (event !== "labeled" && event !== "unlabeled") return { kind: "other" };

	const id = idOf(fieldOf(entry, "id"));
	const at = timestampOf(fieldOf(entry, "created_at"));
	const label = stringOf(pathOf(entry, ["label", "name"]));

	if (id === null || at === null || label === null) return null;

	return {
		kind: event,
		id,
		at,
		actor: actorOf(fieldOf(entry, "actor")),
		label,
	};
}

function parseBodyVersion(value: JsonValue): BodyVersion | null {
	const version = objectOf(value);

	if (version === null) return null;

	const editedAt = timestampOf(fieldOf(version, "editedAt"));
	const deletedAt = fieldOf(version, "deletedAt");
	const diff = fieldOf(version, "diff");

	if (editedAt === null || deletedAt === undefined || diff === undefined) {
		return null;
	}

	const text = diff === null ? null : stringOf(diff);

	if (diff !== null && text === null) return null;

	return { editedAt, deleted: deletedAt !== null, text };
}

function renameTimeOf(value: JsonValue): string | null {
	const rename = objectOf(value);

	if (rename === null) return null;

	const at = timestampOf(fieldOf(rename, "createdAt"));
	const previous = stringOf(fieldOf(rename, "previousTitle"));
	const current = stringOf(fieldOf(rename, "currentTitle"));

	return previous === null || current === null ? null : at;
}

function parseBodyHistory(value: JsonValue | undefined): BodyHistory | null {
	const issue = objectOf(pathOf(value, ["data", "repository", "issue"]));

	if (issue === null) return null;

	const title = stringOf(fieldOf(issue, "title"));
	const body = stringOf(fieldOf(issue, "body"));
	const edited = fieldOf(issue, "lastEditedAt");
	const lastEditedAt = edited === null ? null : timestampOf(edited);
	const includesCreatedEdit = booleanOf(fieldOf(issue, "includesCreatedEdit"));
	const edits = objectOf(fieldOf(issue, "userContentEdits")) ?? {};
	const totalVersions = countOf(fieldOf(edits, "totalCount"));
	const nodes = arrayOf(fieldOf(edits, "nodes"));
	const renames = objectOf(fieldOf(issue, "renames")) ?? {};
	const totalRenames = countOf(fieldOf(renames, "totalCount"));
	const renameNodes = arrayOf(fieldOf(renames, "nodes"));

	if (
		title === null ||
		body === null ||
		(edited !== null && lastEditedAt === null) ||
		includesCreatedEdit === null ||
		totalVersions === null ||
		nodes === null ||
		totalRenames === null ||
		renameNodes === null
	) {
		return null;
	}

	const versions: BodyVersion[] = [];

	for (const node of nodes) {
		const version = parseBodyVersion(node);

		if (version === null) return null;
		versions.push(version);
	}

	const renamedAt: string[] = [];

	for (const node of renameNodes) {
		const at = renameTimeOf(node);

		if (at === null) return null;
		renamedAt.push(at);
	}

	return {
		title,
		body,
		lastEditedAt,
		includesCreatedEdit,
		totalVersions,
		versions,
		totalRenames,
		renamedAt,
	};
}

/**
 * Reads one repository through `gh` with argument arrays. Every request names
 * `repos/<owner>/<name>/...` or GraphQL, and pages are requested by number:
 * `gh --paginate` follows `Link` headers off the integration host.
 */
export class GitHubTicketAdapter implements TicketReader {
	readonly repo: RepoSlug;
	readonly #exec: Exec;
	readonly #paging: GitHubPaging;

	constructor(input: { exec: Exec; repo: RepoSlug; paging?: GitHubPaging }) {
		this.repo = input.repo;
		this.#exec = input.exec;
		this.#paging = input.paging ?? DEFAULT_PAGING;
	}

	ref(issue: number): TicketRef {
		return {
			provider: "github",
			key: `${this.repo}#${issue}`,
			url: issueUrl(this.repo, issue),
		};
	}

	async #gh(args: readonly string[]): Promise<Read<JsonValue>> {
		let result: ExecResult;

		try {
			result = await this.#exec("gh", args);
		} catch {
			return failed({ kind: "cannot_run_gh" });
		}

		if (result.code !== 0) return failed(ghFailure(result));

		const parsed = parseJson(result.stdout);

		return parsed === undefined ? MALFORMED : { kind: "ok", value: parsed };
	}

	async #page(path: string, page: number): Promise<Read<readonly JsonValue[]>> {
		const read = await this.#gh([
			"api",
			`repos/${this.repo}/${path}${path.includes("?") ? "&" : "?"}per_page=${this.#paging.pageSize}&page=${page}`,
		]);

		if (read.kind === "failed") return read;

		const items = arrayOf(read.value);

		return items === null ? MALFORMED : { kind: "ok", value: items };
	}

	/**
	 * Reads up to `maxPages` pages. When all of them are full, one more page
	 * must be empty to prove the list ended; its items are never kept.
	 */
	async #pages(path: string): Promise<Read<JsonValue[]>> {
		const { pageSize, maxPages } = this.#paging;
		const entries: JsonValue[] = [];

		for (let page = 1; page <= maxPages; page++) {
			const read = await this.#page(path, page);

			if (read.kind === "failed") return read;
			entries.push(...read.value);

			if (read.value.length < pageSize) return { kind: "ok", value: entries };
		}

		const confirmation = await this.#page(path, maxPages + 1);

		if (confirmation.kind === "failed") return confirmation;

		return confirmation.value.length === 0
			? { kind: "ok", value: entries }
			: failed({ kind: "pagination_limit" });
	}

	async readIssue(issue: number): Promise<Read<IssueRecord>> {
		const read = await this.#gh(["api", `repos/${this.repo}/issues/${issue}`]);

		if (read.kind === "failed") return read;

		const record = parseIssue(read.value);

		return record === null || record.number !== issue
			? MALFORMED
			: { kind: "ok", value: record };
	}

	async readTimeline(issue: number): Promise<Read<TimelineEntry[]>> {
		const read = await this.#pages(`issues/${issue}/timeline`);

		if (read.kind === "failed") return read;

		const entries: TimelineEntry[] = [];

		for (const item of read.value) {
			const entry = parseTimelineEntry(item);

			if (entry === null) return MALFORMED;
			entries.push(entry);
		}

		return { kind: "ok", value: entries };
	}

	async readPermission(login: Login): Promise<Read<PermissionLevel>> {
		const read = await this.#gh([
			"api",
			`repos/${this.repo}/collaborators/${encodeURIComponent(login)}/permission`,
		]);

		if (read.kind === "failed") return read;

		const permission = stringOf(pathOf(read.value, ["permission"]));
		const user = stringOf(pathOf(read.value, ["user", "login"]));
		const level = permission === null ? null : parsePermissionLevel(permission);

		if (level === null || user?.toLowerCase() !== login.toLowerCase()) {
			return MALFORMED;
		}

		return { kind: "ok", value: level };
	}

	async readBodyHistory(issue: number): Promise<Read<BodyHistory>> {
		const [owner, name] = this.repo.split("/");

		const read = await this.#gh([
			"api",
			"graphql",
			"-f",
			`query=${BODY_HISTORY_QUERY}`,
			"-F",
			`owner=${owner}`,
			"-F",
			`name=${name}`,
			"-F",
			`number=${issue}`,
		]);

		if (read.kind === "failed") return read;

		const history = parseBodyHistory(read.value);

		return history === null ? MALFORMED : { kind: "ok", value: history };
	}

	async readRepoSwitch(): Promise<Read<RepoSwitch>> {
		const read = await this.#gh([
			"api",
			`repos/${this.repo}/labels/${encodeURIComponent(REPO_SWITCH_LABEL)}`,
		]);

		if (read.kind === "failed") {
			const { failure } = read;

			return failure.kind === "gh_failed" && failure.cause === "not_found"
				? { kind: "ok", value: { kind: "absent" } }
				: read;
		}

		const name = stringOf(pathOf(read.value, ["name"]));

		return name === null
			? MALFORMED
			: { kind: "ok", value: { kind: "present", name } };
	}

	#issueOf(ref: TicketRef): number {
		const prefix = `${this.repo}#`;
		const issue = Number(ref.key.slice(prefix.length));

		if (
			ref.provider !== "github" ||
			!ref.key.startsWith(prefix) ||
			!Number.isSafeInteger(issue) ||
			issue < 1
		) {
			throw new Error(`the ref is not an issue of ${this.repo}`);
		}

		return issue;
	}

	#ticketOf(record: IssueRecord): Ticket {
		return {
			ref: this.ref(record.number),
			title: record.title,
			body: record.body,
			labels: [...record.labels],
			author: actorText(record.author),
		};
	}

	/** Reads a repository issue event, as `repos/<repo>/issues/events` lists it. */
	normalize(event: JsonValue): FactoryEvent | null {
		const issue = countOf(pathOf(event, ["issue", "number"]));
		const entry = parseTimelineEntry(event);

		if (
			issue === null ||
			entry?.kind !== "labeled" ||
			entry.label !== READY_LABEL ||
			entry.actor.kind !== "login"
		) {
			return null;
		}

		return {
			kind: "ready",
			id: entry.id,
			at: entry.at,
			ref: this.ref(issue),
			actor: entry.actor.login,
		};
	}

	async fetch(ref: TicketRef): Promise<Ticket> {
		const read = await this.readIssue(this.#issueOf(ref));

		if (read.kind === "failed") throw new GitHubReadError(read.failure);

		return this.#ticketOf(read.value);
	}

	async fetchCandidates(): Promise<Ticket[]> {
		const read = await this.#pages(
			`issues?state=open&labels=${encodeURIComponent(READY_LABEL)}`,
		);

		if (read.kind === "failed") throw new GitHubReadError(read.failure);

		const tickets: Ticket[] = [];

		for (const item of read.value) {
			const record = parseIssue(item);

			if (record === null)
				throw new GitHubReadError({ kind: "malformed_response" });

			if (
				record.open &&
				!record.pullRequest &&
				record.labels.includes(READY_LABEL)
			) {
				tickets.push(this.#ticketOf(record));
			}
		}

		return tickets;
	}

	async fetchStates(
		refs: readonly TicketRef[],
	): Promise<Map<string, TicketState>> {
		const states = new Map<string, TicketState>();

		for (const ref of refs) {
			const read = await this.readIssue(this.#issueOf(ref));

			if (read.kind === "failed") throw new GitHubReadError(read.failure);

			states.set(ticketKey(ref), {
				ref,
				open: read.value.open,
				labels: read.value.labels,
			});
		}

		return states;
	}

	/** False when the login fails GitHub's grammar or the lookup fails. */
	async canAdmit(_ref: TicketRef, actor: string): Promise<boolean> {
		if (!isLogin(actor)) return false;

		const read = await this.readPermission(actor);

		return read.kind === "ok" && hasWriteAccess(read.value);
	}
}

export class GitHubReadError extends Error {
	readonly failure: GitHubFailure;

	constructor(failure: GitHubFailure) {
		super(`GitHub read failed: ${failure.kind}`);
		this.failure = failure;
	}
}
