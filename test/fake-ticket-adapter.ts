import { hasWriteAccess, type PermissionLevel } from "../src/policy.ts";
import type { Run, TicketRef } from "../src/run.ts";
import type { FactoryEvent, Ticket, TicketAdapter } from "../src/tickets.ts";

export type Call =
	| { kind: "report"; ref: TicketRef; run: Run }
	| { kind: "ask"; ref: TicketRef; questions: string[] }
	| { kind: "close"; ref: TicketRef; run: Run };

export class FakeTicketAdapter implements TicketAdapter {
	readonly calls: Call[] = [];
	readonly #tickets = new Map<string, Ticket>();
	readonly #permissions = new Map<string, PermissionLevel>();
	readonly #raw = new WeakMap<object, FactoryEvent>();

	addTicket(ticket: Ticket): void {
		this.#tickets.set(ticket.ref.key, ticket);
	}

	setPermission(actor: string, level: PermissionLevel): void {
		this.#permissions.set(actor, level);
	}

	permissionOf(actor: string): PermissionLevel {
		return this.#permissions.get(actor) ?? "none";
	}

	rawEvent(event: FactoryEvent): object {
		const raw = {};
		this.#raw.set(raw, event);

		return raw;
	}

	normalize(event: unknown): FactoryEvent | null {
		if (typeof event !== "object" || event === null) return null;

		return this.#raw.get(event) ?? null;
	}

	async fetch(ref: TicketRef): Promise<Ticket> {
		const ticket = this.#tickets.get(ref.key);

		if (ticket === undefined) throw new Error(`unknown ticket ${ref.key}`);

		return ticket;
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
