import type { JsonValue } from "../core/json.ts";
import type { Run, TicketRef } from "../core/run.ts";

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
	| {
			kind: "ready";
			id: string;
			at: string;
			ref: TicketRef;
			actor: string;
			/** GitHub typed the label's actor `Bot`, or its login ends in `[bot]`. */
			bot: boolean;
	  }
	| { kind: "answered"; id: string; at: string; ref: TicketRef; actor: string }
	| {
			kind: "cancelled";
			id: string;
			at: string;
			ref: TicketRef;
			actor: string;
	  };

export type TicketState = {
	readonly ref: TicketRef;
	readonly open: boolean;
	readonly labels: readonly string[];
};

/**
 * The map key for a ticket. A ref's `key` already names its repository, such
 * as `owner/name#42`, and this adds the provider.
 */
export function ticketKey(ref: TicketRef): string {
	return `${ref.provider}:${ref.key}`;
}

/** The account that applied a ready label. */
export type ReadyActor = { readonly login: string; readonly bot: boolean };

export interface TicketReader {
	normalize(event: JsonValue): FactoryEvent | null;
	fetch(ref: TicketRef): Promise<Ticket>;
	/** Open tickets that carry the ready label now. */
	fetchCandidates(): Promise<Ticket[]>;
	/** Keyed by `ticketKey`. */
	fetchStates(refs: readonly TicketRef[]): Promise<Map<string, TicketState>>;
	/** Refuses every bot before any permission read. */
	canAdmit(ref: TicketRef, actor: ReadyActor): Promise<boolean>;
}

/**
 * `posted` names the new comment. `rejected` means it was not created. A
 * comment may exist after `unknown`, so read before posting again.
 */
export type CommentPost =
	| { readonly kind: "posted"; readonly id: string }
	| { readonly kind: "rejected" }
	| { readonly kind: "unknown" };

/**
 * A label write, with the same meaning as `CommentPost`: `unknown` may
 * have changed the labels, so read before relying on them.
 */
export type LabelWrite =
	| { readonly kind: "posted" }
	| { readonly kind: "rejected" }
	| { readonly kind: "unknown" };

/** The controller's only write path. It is separate from `TicketReader`. */
export interface TicketWriter {
	postComment(issue: number, body: string): Promise<CommentPost>;
	addLabels(issue: number, names: readonly string[]): Promise<LabelWrite>;
	removeLabel(issue: number, name: string): Promise<LabelWrite>;
}

export interface TicketAdapter extends TicketReader {
	report(ref: TicketRef, run: Run): Promise<void>;
	ask(ref: TicketRef, questions: string[]): Promise<void>;
	close(ref: TicketRef, run: Run): Promise<void>;
}
