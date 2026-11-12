import type { PlatformProfile } from "../../src/trust/platform.ts";
import { objectOf, type JsonValue } from "../../src/core/json.ts";
import type { LedgerBacklog } from "../../src/ledger/outbox.ts";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Log, LogFields, Orchestrator } from "../../src/orchestrator.ts";
import { parseJson, writeAtomic, writeStatus } from "./state.ts";

const LOG_VALUE = /^[A-Za-z0-9:._@/[\]+-]*$/;

/** One structured log line: `at=<time> event=<name> key=value ...`. */
export function logLine(at: number, event: string, fields: LogFields): string {
	const parts = [`at=${new Date(at).toISOString()}`, `event=${event}`];

	for (const [key, value] of Object.entries(fields)) {
		const text = String(value);

		parts.push(`${key}=${LOG_VALUE.test(text) ? text : "(withheld)"}`);
	}

	return `${parts.join(" ")}\n`;
}

export function lineLog(write: (text: string) => void, now: () => number): Log {
	return (event, fields) => write(logLine(now(), event, fields));
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

export async function systemdNotify(
	message: "READY=1" | "WATCHDOG=1",
): Promise<void> {
	if (!process.env.NOTIFY_SOCKET) return;
	await new Promise<void>((done, reject) => {
		const child = spawn("systemd-notify", [message], {
			detached: message === "WATCHDOG=1",
			stdio: "ignore",
			timeout: 1000,
			killSignal: "SIGKILL",
		});

		child.once("error", reject);
		child.once("close", (code) =>
			code === 0 ? done() : reject(new Error("notify_exit")),
		);

		if (message === "WATCHDOG=1") child.unref();
	});
}

export function startMetricSnapshots(input: {
	stateDir: string;
	collect: () => Promise<JsonValue>;
	log: Log;
	intervalMs?: number;
}) {
	let pending: Promise<void> | null = null;

	const refresh = () => {
		if (pending !== null) return;
		pending = (async () => {
			try {
				const snapshot = await input.collect();

				if (
					!(await writeAtomic(
						join(input.stateDir, "metrics.json"),
						`${JSON.stringify(snapshot)}\n`,
					))
				)
					input.log("metrics_unwritable", {});
			} catch (error) {
				const reason =
					error instanceof Error &&
					[
						"metric_deadline",
						"ledger_missing",
						"ledger_ref_unavailable",
						"ledger_commit_unavailable",
						"ledger_file_unavailable",
						"label_missing",
						"label_unreadable",
						"defect_query_failed",
						"defect_query_invalid",
						"defect_query_incomplete",
						"intervention_unreadable",
						"receipt_read_unavailable",
						"metric_compute_unavailable",
					].includes(error.message)
						? error.message
						: "collection_failed";

				input.log("metrics_unavailable", { reason });

				const previous = objectOf(
					parseJson(
						await readFile(join(input.stateDir, "metrics.json"), "utf8").catch(
							() => "null",
						),
					),
				);

				if (previous !== null)
					await writeAtomic(
						join(input.stateDir, "metrics.json"),
						`${JSON.stringify({ ...previous, stale: true, lastAttemptAt: new Date().toISOString() })}\n`,
					);
			}
		})().finally(() => {
			pending = null;
		});
	};

	refresh();
	const timer = setInterval(refresh, input.intervalMs ?? 300_000);
	timer.unref();

	return {
		stop: async () => {
			clearInterval(timer);
			await pending;
		},
	};
}

export async function serveLoop(input: {
	orchestrator: Pick<Orchestrator, "tick" | "pollIntervalMs">;
	stateDir: string;
	platform: PlatformProfile;
	sleep: Sleep;
	signal: AbortSignal;
	log: Log;
	pump?: () => Promise<LedgerBacklog | null>;
	scorePump?: () => Promise<boolean | null>;
	durableUsage?: () => JsonValue;
	notify?: (message: "READY=1" | "WATCHDOG=1") => Promise<void>;
}): Promise<void> {
	const { orchestrator, signal, log } = input;
	const notify = input.notify ?? systemdNotify;
	let notifyMissing = false;

	const ping = async (message: "READY=1" | "WATCHDOG=1") => {
		if (notifyMissing) return;

		try {
			await notify(message);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT")
				notifyMissing = true;

			log("notify_failed", { message });
		}
	};

	await ping("READY=1");
	let watchdogPending = false;
	let scheduled: NodeJS.Immediate | null = null;

	const watchdog = () => {
		if (notifyMissing || watchdogPending) return;
		watchdogPending = true;
		scheduled = setImmediate(() => {
			scheduled = null;
			void ping("WATCHDOG=1").finally(() => {
				watchdogPending = false;
			});
		});
		scheduled.unref();
	};

	let scorePending: Promise<void> | null = null;
	let scoreScheduled: NodeJS.Immediate | null = null;

	const scores = () => {
		if (
			input.scorePump === undefined ||
			scorePending !== null ||
			scoreScheduled !== null
		)
			return;
		scoreScheduled = setImmediate(() => {
			scoreScheduled = null;
			scorePending = input.scorePump!()
				.then(() => undefined)
				.catch(() => {
					log("score_pump_failed", {});
				})
				.finally(() => {
					scorePending = null;
				});
		});
		scoreScheduled.unref();
	};

	while (!signal.aborted) {
		watchdog();
		const report = await orchestrator.tick();

		const written = await writeStatus(
			input.stateDir,
			report,
			input.platform,
			input.durableUsage?.(),
		);

		if (!written) log("status_unwritable", {});

		watchdog();
		scores();

		await input.pump?.();

		if (signal.aborted) break;

		await input.sleep(orchestrator.pollIntervalMs, signal);
	}

	if (scheduled !== null) clearImmediate(scheduled);

	if (scoreScheduled !== null) clearImmediate(scoreScheduled);
	await scorePending;
	log("controller_stopping", {});
}
