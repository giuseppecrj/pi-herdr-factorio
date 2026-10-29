import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	hasWriteAccess,
	type PermissionLevel,
	READY_LABEL,
} from "../src/policy.ts";
import type { Run, TicketRef } from "../src/run.ts";
import {
	type FactoryEvent,
	type JsonValue,
	type Ticket,
	type TicketAdapter,
	type TicketState,
	ticketKey,
} from "../src/tickets.ts";
import type { Exec, ExecResult } from "../src/workflow.ts";

export type Call =
	| { kind: "report"; ref: TicketRef; run: Run }
	| { kind: "ask"; ref: TicketRef; questions: string[] }
	| { kind: "close"; ref: TicketRef; run: Run };

export class FakeTicketAdapter implements TicketAdapter {
	readonly calls: Call[] = [];
	readonly #tickets = new Map<string, Ticket>();
	readonly #closed = new Set<string>();
	readonly #permissions = new Map<string, PermissionLevel>();
	readonly #raw = new Map<JsonValue, FactoryEvent>();

	addTicket(ticket: Ticket): void {
		this.#tickets.set(ticketKey(ticket.ref), ticket);
	}

	closeTicket(ref: TicketRef): void {
		this.#closed.add(ticketKey(ref));
	}

	setPermission(actor: string, level: PermissionLevel): void {
		this.#permissions.set(actor, level);
	}

	permissionOf(actor: string): PermissionLevel {
		return this.#permissions.get(actor) ?? "none";
	}

	rawEvent(event: FactoryEvent) {
		const raw = {};
		this.#raw.set(raw, event);

		return raw;
	}

	normalize(event: JsonValue): FactoryEvent | null {
		return this.#raw.get(event) ?? null;
	}

	async fetch(ref: TicketRef): Promise<Ticket> {
		const ticket = this.#tickets.get(ticketKey(ref));

		if (ticket === undefined) throw new Error(`unknown ticket ${ref.key}`);

		return ticket;
	}

	async fetchCandidates(): Promise<Ticket[]> {
		return [...this.#tickets.values()].filter(
			(ticket) =>
				ticket.labels.includes(READY_LABEL) &&
				!this.#closed.has(ticketKey(ticket.ref)),
		);
	}

	async fetchStates(
		refs: readonly TicketRef[],
	): Promise<Map<string, TicketState>> {
		const states = new Map<string, TicketState>();

		for (const ref of refs) {
			const ticket = await this.fetch(ref);

			states.set(ticketKey(ref), {
				ref,
				open: !this.#closed.has(ticketKey(ref)),
				labels: ticket.labels,
			});
		}

		return states;
	}

	async canAdmit(_ref: TicketRef, actor: string): Promise<boolean> {
		return hasWriteAccess(this.permissionOf(actor));
	}

	async report(ref: TicketRef, run: Run): Promise<void> {
		this.calls.push({ kind: "report", ref, run });
	}

	async ask(ref: TicketRef, questions: string[]): Promise<void> {
		this.calls.push({ kind: "ask", ref, questions });
	}

	async close(ref: TicketRef, run: Run): Promise<void> {
		this.calls.push({ kind: "close", ref, run });
	}
}

export const FAKE_REPO = "giuseppecrj/pi-herdr-factorio";

export const MAIN_SHA = "c".repeat(40);

export const TRUSTED_WORKFLOW = readFileSync(
	fileURLToPath(new URL("../.github/factory/WORKFLOW.md", import.meta.url)),
	"utf8",
);

export type FakeVersion = {
	editedAt: string;
	deletedAt: string | null;
	diff: string | null;
};

export type FakeRename = {
	createdAt: string;
	previousTitle: string;
	currentTitle: string;
};

export type FakeComment = {
	id: number;
	nodeId: string;
	login: string;
	type: "Bot" | "User";
	appSlug: string | null;
	body: string;
	createdAt: string;
	lastEditedAt: string | null;
	/** Overrides the issue the REST `issue_url` names. */
	issueUrl?: string;
};

export type FakeIssue = {
	number: number;
	updatedAt: string;
	state: "open" | "closed";
	title: string;
	body: string;
	author: string;
	labels: string[];
	pullRequest: boolean;
	timeline: JsonValue[];
	lastEditedAt: string | null;
	includesCreatedEdit: boolean;
	versions: FakeVersion[];
	totalVersions: number | null;
	renames: FakeRename[];
	totalRenames: number | null;
	comments: FakeComment[];
};

export function fakeIssue(number: number, change: Partial<FakeIssue> = {}) {
	const issue: FakeIssue = {
		number,
		updatedAt: "2026-10-29T01:00:00Z",
		state: "open",
		title: `Fixture ${number}`,
		body: `Body of fixture ${number}.`,
		author: "exe-dev-github-integration[bot]",
		labels: [READY_LABEL],
		pullRequest: false,
		timeline: [],
		lastEditedAt: null,
		includesCreatedEdit: false,
		versions: [],
		totalVersions: null,
		renames: [],
		totalRenames: null,
		comments: [],
		...change,
	};

	return issue;
}

export function labelEvent(input: {
	id: number;
	at: string;
	actor: string;
	label?: string;
	event?: "labeled" | "unlabeled";
}): JsonValue {
	return {
		id: input.id,
		event: input.event ?? "labeled",
		actor: { login: input.actor, type: "User" },
		created_at: input.at,
		label: { name: input.label ?? READY_LABEL, color: "ededed" },
	};
}

export function renamedEvent(at: string): JsonValue {
	return {
		id: 1,
		event: "renamed",
		actor: { login: "giuseppecrj" },
		created_at: at,
		rename: { from: "old", to: "new" },
	};
}

export function commentEvent(id: number, at: string): JsonValue {
	return {
		id,
		event: "commented",
		user: { login: "exe-dev-github-integration[bot]", type: "Bot" },
		created_at: at,
		body: "a comment",
	};
}

function ok(value: JsonValue | string): ExecResult {
	const stdout = value === String(value) ? value : JSON.stringify(value);

	return { stdout, stderr: "", code: 0 };
}

export function httpError(status: number, message = "Failed"): ExecResult {
	return {
		stdout: JSON.stringify({ message, status: String(status) }),
		stderr: `gh: ${message} (HTTP ${status})\n`,
		code: 1,
	};
}

export function networkError(): ExecResult {
	return {
		stdout: "",
		stderr: "error connecting to api.github.com\n",
		code: 1,
	};
}

export const BOT_LOGIN = "exe-dev-github-integration[bot]";

/** What the next comment POSTs do: answer, fail with a status, or land and then time out. */
export type PostBehavior = "ok" | "rejected" | "lost" | "landed_unanswered";

export class FakeGitHub {
	readonly calls: string[][] = [];
	viewer = BOT_LOGIN;
	posts: PostBehavior[] = [];
	now = "2026-10-29T02:00:00Z";
	#nextCommentId = 9000;
	readonly issues = new Map<number, FakeIssue>();
	readonly permissions = new Map<string, string>();
	readonly failures = new Map<string, ExecResult>();
	workflow: string | null = TRUSTED_WORKFLOW;
	repoLabels: string[] = ["factory:enabled"];
	beforeGraphql: ((issue: FakeIssue) => void) | null = null;

	constructor() {
		this.permissions.set("giuseppecrj", "admin");
		this.permissions.set("writer", "write");
		this.permissions.set("triager", "read");
		this.permissions.set("exe-dev-github-integration[bot]", "none");
	}

	add(issue: FakeIssue): FakeIssue {
		this.issues.set(issue.number, issue);

		return issue;
	}

	readonly exec: Exec = async (command, args) => {
		this.calls.push([command, ...args]);

		if (command !== "gh" || args[0] !== "api") return httpError(400);

		const path = args.find((arg) => arg.startsWith("repos/")) ?? "graphql";

		for (const [prefix, result] of this.failures) {
			if (path.startsWith(prefix)) return result;
		}

		if (args[1] === "--method" && args[2] === "POST") {
			return this.#post(path, args);
		}

		return this.#answer(path, args);
	};

	/** Adds a comment as `login`, as another account or the bot would. */
	comment(
		issue: FakeIssue,
		body: string,
		change: Partial<FakeComment> = {},
	): FakeComment {
		const id = this.#nextCommentId++;

		const comment: FakeComment = {
			id,
			nodeId: `IC_${id}`,
			login: BOT_LOGIN,
			type: "Bot",
			appSlug: "exe-dev-github-integration",
			body,
			createdAt: this.now,
			lastEditedAt: null,
			...change,
		};

		issue.comments.push(comment);
		issue.updatedAt = this.now;

		return comment;
	}

	markers(issue: number): string[] {
		return (this.issues.get(issue)?.comments ?? []).flatMap((comment) =>
			comment.login === BOT_LOGIN ? [comment.body] : [],
		);
	}

	#post(path: string, args: readonly string[]): ExecResult {
		const match = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.exec(path);
		const issue = this.issues.get(Number(match?.[1]));
		const body = args.find((arg) => arg.startsWith("body="))?.slice(5);
		const behavior = this.posts.shift() ?? "ok";

		if (issue === undefined || body === undefined) {
			return httpError(404, "Not Found");
		}

		if (behavior === "rejected") return httpError(422, "Invalid request");

		if (behavior === "lost") return networkError();

		const comment = this.comment(issue, body);

		if (behavior === "landed_unanswered") {
			return { stdout: "", stderr: "", code: 137 };
		}

		return ok({ id: comment.id, node_id: comment.nodeId });
	}

	#answer(path: string, args: readonly string[]): ExecResult {
		const prefix = `repos/${FAKE_REPO}/`;

		if (path === "graphql") return this.#graphql(args);

		if (!path.startsWith(prefix)) return httpError(404, "Not Found");

		const url = new URL(path.slice(prefix.length), "https://fake.invalid/");
		const route = url.pathname.slice(1);

		if (route === "git/ref/heads/main") return ok(`${MAIN_SHA}\n`);

		if (route === "contents/.github/factory/WORKFLOW.md") {
			return this.workflow === null
				? httpError(404, "Not Found")
				: ok(this.workflow);
		}

		const label = /^labels\/([^/]+)$/.exec(route);

		if (label !== null) {
			const wanted = decodeURIComponent(label[1] ?? "").toLowerCase();

			const name = this.repoLabels.find(
				(stored) => stored.toLowerCase() === wanted,
			);

			return name === undefined
				? httpError(404, "Not Found")
				: ok({ id: 1, name, color: "0E8A16", default: false });
		}

		const permission = /^collaborators\/([^/]+)\/permission$/.exec(route);

		if (permission !== null) {
			const login = decodeURIComponent(permission[1] ?? "");
			const level = this.permissions.get(login);

			return level === undefined
				? httpError(404, `${login} is not a user`)
				: ok({ permission: level, role_name: level, user: { login } });
		}

		if (route === "issues") {
			const open = [...this.issues.values()].filter(
				(issue) =>
					issue.state === "open" &&
					issue.labels.includes(url.searchParams.get("labels") ?? ""),
			);

			return ok(
				this.#page(
					open.map((issue) => this.#rest(issue)),
					url,
				),
			);
		}

		const match = /^issues\/(\d+)(\/timeline|\/comments)?$/.exec(route);
		const issue = this.issues.get(Number(match?.[1]));

		if (match === null || issue === undefined) {
			return httpError(404, "Not Found");
		}

		if (match[2] === "/comments") {
			return ok(
				this.#page(
					issue.comments.map((comment) => this.#restComment(issue, comment)),
					url,
				),
			);
		}

		return match[2] === undefined
			? ok(this.#rest(issue))
			: ok(this.#page(issue.timeline, url));
	}

	#restComment(issue: FakeIssue, comment: FakeComment): JsonValue {
		return {
			id: comment.id,
			node_id: comment.nodeId,
			issue_url:
				comment.issueUrl ??
				`https://api.github.com/repos/${FAKE_REPO}/issues/${issue.number}`,
			user: { login: comment.login, type: comment.type },
			performed_via_github_app:
				comment.appSlug === null ? null : { slug: comment.appSlug, id: 1 },
			body: comment.body,
			created_at: comment.createdAt,
			updated_at: comment.lastEditedAt ?? comment.createdAt,
		};
	}

	#commentNodes(args: readonly string[]): ExecResult {
		const ids = args.flatMap((arg) =>
			arg.startsWith("ids[]=") ? [arg.slice(6)] : [],
		);

		const nodes: JsonValue[] = ids.map((id) => {
			for (const issue of this.issues.values()) {
				const comment = issue.comments.find((item) => item.nodeId === id);

				if (comment !== undefined) {
					return {
						__typename: "IssueComment",
						databaseId: comment.id,
						lastEditedAt: comment.lastEditedAt,
						issue: {
							number: issue.number,
							repository: { nameWithOwner: FAKE_REPO },
						},
					};
				}
			}

			return null;
		});

		return ok({ data: { nodes } });
	}

	#page(items: readonly JsonValue[], url: URL): JsonValue[] {
		const size = Number(url.searchParams.get("per_page") ?? 30);
		const page = Number(url.searchParams.get("page") ?? 1);

		return items.slice((page - 1) * size, page * size);
	}

	#rest(issue: FakeIssue): JsonValue {
		const fields = {
			number: issue.number,
			updated_at: issue.updatedAt,
			state: issue.state,
			title: issue.title,
			body: issue.body === "" ? null : issue.body,
			user: { login: issue.author },
			labels: issue.labels.map((name) => ({ name })),
		};

		return issue.pullRequest
			? { ...fields, pull_request: { url: "x" } }
			: fields;
	}

	#graphql(args: readonly string[]): ExecResult {
		const query = args.find((arg) => arg.startsWith("query=")) ?? "";

		if (query.includes("viewer")) {
			return ok({ data: { viewer: { login: this.viewer } } });
		}

		if (query.includes("nodes(ids:")) return this.#commentNodes(args);

		const number = Number(
			args.find((arg) => arg.startsWith("number="))?.slice(7),
		);

		const issue = this.issues.get(number);

		if (issue === undefined) {
			return {
				stdout: JSON.stringify({ data: { repository: { issue: null } } }),
				stderr: `gh: Could not resolve to an Issue with the number of ${number}.\n`,
				code: 1,
			};
		}

		this.beforeGraphql?.(issue);

		return ok({
			data: {
				repository: {
					issue: {
						title: issue.title,
						body: issue.body === "" ? null : issue.body,
						lastEditedAt: issue.lastEditedAt,
						includesCreatedEdit: issue.includesCreatedEdit,
						userContentEdits: {
							totalCount: issue.totalVersions ?? issue.versions.length,
							nodes: issue.versions,
						},
						renames: {
							totalCount: issue.totalRenames ?? issue.renames.length,
							nodes: issue.renames,
						},
					},
				},
			},
		});
	}
}
