import type { Run, TicketRef } from "./run.ts";

export type Ticket = {
	ref: TicketRef;
	title: string;
	body: string;
	labels: string[];
	author: string;
};

/**
 * Every event names the provider's event ID and its ISO 8601 UTC time, so a
 * poller can drop an event it has already seen.
 */
export type FactoryEvent =
	| { kind: "ready"; id: string; at: string; ref: TicketRef; actor: string }
	| { kind: "answered"; id: string; at: string; ref: TicketRef; actor: string }
	| {
			kind: "cancelled";
			id: string;
			at: string;
			ref: TicketRef;
			actor: string;
	  }
	| {
			kind: "pr_feedback";
			id: string;
			at: string;
			ref: TicketRef;
			actor: string;
			prUrl: string;
			comment: string;
	  };

export type TicketState = {
	readonly ref: TicketRef;
	readonly open: boolean;
	readonly labels: readonly string[];
};

/** A JSON value as `gh` prints it: an event before `normalize` parses it. */
export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

/**
 * The map key for a ticket. A ref's `key` already names its repository, such
 * as `owner/name#42`, and this adds the provider.
 */
export function ticketKey(ref: TicketRef): string {
	return `${ref.provider}:${ref.key}`;
}

export interface TicketReader {
	normalize(event: JsonValue): FactoryEvent | null;
	fetch(ref: TicketRef): Promise<Ticket>;
	/** Open tickets that carry the ready label now. */
	fetchCandidates(): Promise<Ticket[]>;
	/** Keyed by `ticketKey`. */
	fetchStates(refs: readonly TicketRef[]): Promise<Map<string, TicketState>>;
	canAdmit(ref: TicketRef, actor: string): Promise<boolean>;
}

/**
 * `posted` names the new comment. `rejected` means it was not created. A
 * comment may exist after `unknown`, so read before posting again.
 */
export type CommentPost =
	| { readonly kind: "posted"; readonly id: string }
	| { readonly kind: "rejected" }
	| { readonly kind: "unknown" };

/** The controller's only write path. It is separate from `TicketReader`. */
export interface TicketWriter {
	postComment(issue: number, body: string): Promise<CommentPost>;
}

export interface TicketAdapter extends TicketReader {
	report(ref: TicketRef, run: Run): Promise<void>;
	ask(ref: TicketRef, questions: string[]): Promise<void>;
	close(ref: TicketRef, run: Run): Promise<void>;
}
