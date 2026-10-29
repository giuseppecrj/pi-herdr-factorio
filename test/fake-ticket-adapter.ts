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

export type FakeIssue = {
	number: number;
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
};

export function fakeIssue(number: number, change: Partial<FakeIssue> = {}) {
	const issue: FakeIssue = {
		number,
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

/**
 * Answers the `gh api` requests the GitHub adapter makes, from in-memory
 * issues. `failures` maps a request path prefix to the result it gets.
 */
export class FakeGitHub {
	readonly calls: string[][] = [];
	readonly issues = new Map<number, FakeIssue>();
	readonly permissions = new Map<string, string>();
	readonly failures = new Map<string, ExecResult>();
	workflow: string | null = TRUSTED_WORKFLOW;
	repoLabels: string[] = ["factory:enabled"];
	/** Runs just before a GraphQL answer, to change an issue between reads. */
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

		return this.#answer(path, args);
	};

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

		const match = /^issues\/(\d+)(\/timeline)?$/.exec(route);
		const issue = this.issues.get(Number(match?.[1]));

		if (match === null || issue === undefined) {
			return httpError(404, "Not Found");
		}

		return match[2] === undefined
			? ok(this.#rest(issue))
			: ok(this.#page(issue.timeline, url));
	}

	#page(items: readonly JsonValue[], url: URL): JsonValue[] {
		const size = Number(url.searchParams.get("per_page") ?? 30);
		const page = Number(url.searchParams.get("page") ?? 1);

		return items.slice((page - 1) * size, page * size);
	}

	#rest(issue: FakeIssue): JsonValue {
		const fields = {
			number: issue.number,
			state: issue.state,
			title: issue.title,
			body: issue.body,
			user: { login: issue.author },
			labels: issue.labels.map((name) => ({ name })),
		};

		return issue.pullRequest
			? { ...fields, pull_request: { url: "x" } }
			: fields;
	}

	#graphql(args: readonly string[]): ExecResult {
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
						body: issue.body,
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
