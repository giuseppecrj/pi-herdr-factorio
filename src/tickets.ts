import type { Run, TicketRef } from "./run.ts";

export type Ticket = {
	ref: TicketRef;
	title: string;
	body: string;
	labels: string[];
	author: string;
};

export type FactoryEvent =
	| { kind: "ready"; ref: TicketRef; actor: string }
	| { kind: "answered"; ref: TicketRef; actor: string }
	| { kind: "cancelled"; ref: TicketRef; actor: string }
	| {
			kind: "pr_feedback";
			ref: TicketRef;
			actor: string;
			prUrl: string;
			comment: string;
	  };

export interface TicketAdapter {
	normalize(event: unknown): FactoryEvent | null;
	fetch(ref: TicketRef): Promise<Ticket>;
	canAdmit(ref: TicketRef, actor: string): Promise<boolean>;
	report(ref: TicketRef, run: Run): Promise<void>;
	ask(ref: TicketRef, questions: string[]): Promise<void>;
	close(ref: TicketRef, run: Run): Promise<void>;
}
