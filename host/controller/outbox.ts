import { lstat, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	fieldOf as jsonField,
	objectOf,
	parseJson as parseJsonText,
	textOf,
} from "../../src/core/json.ts";
import { isDigest, type Digest } from "../../src/core/run.ts";
import type { Exec } from "../../src/github/exec.ts";
import { GitHubPublicationApi } from "../../src/github/publish.ts";
import { parseAdoption, parseAnchor } from "../../src/ledger/append.ts";
import { ledgerApiOf } from "../../src/ledger/git.ts";
import {
	parseRetry,
	pumpLedger,
	type LedgerBacklog,
	type LedgerOutbox,
	type OutboxJob,
} from "../../src/ledger/outbox.ts";
import {
	frozenRowOf,
	LedgerRowError,
	ledgerRowOf,
} from "../../src/ledger/schema.ts";
import type { Log } from "../../src/controller/orchestrator.ts";
import type { PlatformProfile, RepoSlug } from "../../src/trust/platform.ts";
import { installOnce, writeAtomic } from "./state.ts";

/**
 * The controller-private ledger outbox under `<state>/ledger`. Each run's
 * terminal snapshot and row are write-once; only its retry record and the
 * shared anchor are replaced.
 */
export function fileLedgerOutbox(stateDir: string): LedgerOutbox {
	const root = join(resolve(stateDir), "ledger");
	const dirOf = (runId: string) => join(root, runId);

	const readText = (path: string) =>
		readFile(path, "utf8").then(
			(text) => text,
			(error: NodeJS.ErrnoException) =>
				error.code === "ENOENT" ? null : Promise.reject(error),
		);

	const invalidJob = async (
		runId: Digest,
		observedAt: string | null,
	): Promise<OutboxJob> => ({
		runId,
		observedAt:
			observedAt ??
			(await stat(dirOf(runId)).then(
				(info) => info.mtime.toISOString(),
				() => new Date(0).toISOString(),
			)),
		row: null,
		retry: { attempts: 1, nextAt: 0, reason: "state_invalid", blocked: true },
		adoption: null,
	});

	/** One job, `null` when it is published or not yet enrolled; a corrupt record blocks only it. */
	const jobOf = async (runId: Digest): Promise<OutboxJob | null> => {
		const dir = dirOf(runId);
		let observedAt: string | null = null;

		try {
			if ((await readText(join(dir, "published.json"))) !== null) return null;
			const terminal = await readText(join(dir, "terminal.json"));

			if (terminal === null) {
				const blocked = await readText(join(dir, "blocked.json"));

				if (blocked === null) return null;

				const at = textOf(
					jsonField(objectOf(parseJsonText(blocked)), "observedAt"),
				);

				if (at === null || !validLedgerInstant(at))
					return invalidJob(runId, null);

				return {
					runId,
					observedAt: at,
					row: null,
					retry: {
						attempts: 1,
						nextAt: 0,
						reason: "row_invalid",
						blocked: true,
					},
					adoption: null,
				};
			}

			observedAt = textOf(
				jsonField(objectOf(parseJsonText(terminal)), "terminalObservedAt"),
			);

			if (observedAt === null) return invalidJob(runId, null);

			const rowBytes = await readFile(join(dir, "row.json")).catch(
				(error: NodeJS.ErrnoException) =>
					error.code === "ENOENT" ? null : Promise.reject(error),
			);

			const row = rowBytes === null ? null : frozenRowOf(rowBytes);

			if (rowBytes !== null && row === null)
				return invalidJob(runId, observedAt);
			const retryText = await readText(join(dir, "retry.json"));

			const retry =
				retryText === null ? null : parseRetry(parseJsonText(retryText));

			if (retryText !== null && retry === null)
				return invalidJob(runId, observedAt);
			const adoptionText = await readText(join(dir, "adoption.json"));

			const adoption =
				adoptionText === null
					? null
					: parseAdoption(parseJsonText(adoptionText));

			if (adoptionText !== null && adoption === null)
				return invalidJob(runId, observedAt);

			return { runId, observedAt, row, retry, adoption };
		} catch {
			return invalidJob(runId, observedAt);
		}
	};

	return {
		async prepare(runId, snapshot) {
			const path = join(dirOf(runId), "terminal.json");
			const existing = await readFile(path, "utf8").catch(() => null);

			if (existing !== null) return parseJsonText(existing) !== undefined;

			return installOnce(path, `${JSON.stringify(snapshot)}\n`);
		},
		async block(runId, observedAt) {
			const path = join(dirOf(runId), "blocked.json");
			const existing = await readFile(path, "utf8").catch(() => null);

			if (existing !== null) return true;

			return installOnce(path, `${JSON.stringify({ v: 1, observedAt })}\n`);
		},
		async freeze(runId, marker) {
			const dir = dirOf(runId);
			const stored = await readFile(join(dir, "row.json")).catch(() => null);

			if (stored !== null)
				return frozenRowOf(stored)?.row.runId === runId ? "frozen" : "invalid";

			const terminal = await readFile(join(dir, "terminal.json"), "utf8").catch(
				() => null,
			);

			if (terminal === null) return "absent";
			const snapshot = objectOf(parseJsonText(terminal));

			if (snapshot === null) return "invalid";
			let bytes: Buffer;

			try {
				const row = ledgerRowOf({
					...snapshot,
					terminalMarker: { seq: marker.seq, digest: marker.digest },
				});

				if (row.row.runId !== runId) return "invalid";
				bytes = row.bytes;
			} catch (error) {
				if (error instanceof LedgerRowError) return "invalid";
				throw error;
			}

			return (await installOnce(join(dir, "row.json"), bytes.toString()))
				? "frozen"
				: "unwritable";
		},
		async scan() {
			try {
				const names = await readdir(root).catch(
					(error: NodeJS.ErrnoException) =>
						error.code === "ENOENT" ? [] : Promise.reject(error),
				);

				const jobs: OutboxJob[] = [];

				for (const runId of names.sort()) {
					if (!isDigest(runId)) continue;
					const job = await jobOf(runId);

					if (job !== null) jobs.push(job);
				}

				return jobs;
			} catch {
				return null;
			}
		},
		async anchor() {
			try {
				const text = await readText(join(root, "anchor.json"));

				if (text !== null) return parseAnchor(parseJsonText(text)) ?? "invalid";

				const names = await readdir(root).catch(
					(error: NodeJS.ErrnoException) =>
						error.code === "ENOENT" ? [] : Promise.reject(error),
				);

				for (const runId of names)
					if (
						isDigest(runId) &&
						(await lstat(join(dirOf(runId), "published.json")).then(
							() => true,
							(error: NodeJS.ErrnoException) =>
								error.code === "ENOENT" ? false : Promise.reject(error),
						))
					)
						return "orphaned";

				return null;
			} catch {
				return "invalid";
			}
		},
		async published(receipt, anchor) {
			const installed = await installOnce(
				join(dirOf(receipt.runId), "published.json"),
				`${JSON.stringify(receipt)}\n`,
			);

			if (!installed) return false;
			await writeAtomic(
				join(root, "anchor.json"),
				`${JSON.stringify(anchor)}\n`,
			);

			return true;
		},
		async adoption(runId, cursor) {
			return writeAtomic(
				join(dirOf(runId), "adoption.json"),
				`${JSON.stringify(cursor)}\n`,
			);
		},
		async retry(runId, retry) {
			try {
				await mkdir(dirOf(runId), { recursive: true, mode: 0o700 });
			} catch {
				return false;
			}

			return writeAtomic(
				join(dirOf(runId), "retry.json"),
				`${JSON.stringify(retry)}\n`,
			);
		},
	};
}

/** Read-only per-run token floors; aggregate execution receipts cover their descendants. */
export function validLedgerInstant(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value))
		return false;
	const time = Date.parse(value);

	return (
		Number.isFinite(time) &&
		new Date(time).toISOString() === value.replace(/(?<!\.[0-9]{3})Z$/, ".000Z")
	);
}

export async function readLedgerBacklog(stateDir: string | null, now: number) {
	const available =
		stateDir !== null &&
		(await lstat(stateDir).then(
			(info) => info.isDirectory(),
			() => false,
		));

	const jobs =
		stateDir === null || !available
			? null
			: await fileLedgerOutbox(stateDir).scan();

	const blocked = jobs?.filter((job) => job.retry?.blocked).length ?? null;
	const oldest = jobs?.map((job) => job.observedAt).sort()[0] ?? null;

	const next =
		jobs
			?.flatMap((job) => (job.retry === null ? [] : [job.retry.nextAt]))
			.sort((a, b) => a - b)[0] ?? null;

	return {
		state:
			stateDir === null
				? "unavailable"
				: jobs === null
					? "unreadable"
					: (blocked ?? 0) > 0
						? "blocked"
						: jobs.length > 0
							? "pending"
							: "empty",
		pending: jobs?.length ?? null,
		blocked,
		oldestObservedAt: oldest,
		oldestAgeMs: oldest === null ? null : Math.max(0, now - Date.parse(oldest)),
		nextAttemptAt: next === null ? null : new Date(next).toISOString(),
		lastError: jobs?.find((job) => job.retry !== null)?.retry?.reason ?? null,
	};
}

/**
 * One pass of the ledger outbox for this state directory. It reads and
 * advances only `factory/ledger`, and never fails the tick that calls it.
 */
export async function pumpLedgerOutbox(input: {
	readonly stateDir: string;
	readonly exec: Exec;
	readonly platform: PlatformProfile;
	readonly repo: RepoSlug;
	readonly now: number;
	readonly log: Log;
	readonly clock?: () => number;
}): Promise<LedgerBacklog | null> {
	const clock = input.clock ?? Date.now;
	const started = clock();

	try {
		const backlog = await pumpLedger(
			fileLedgerOutbox(input.stateDir),
			ledgerApiOf(
				new GitHubPublicationApi(
					input.exec,
					input.repo,
					input.platform,
					{},
					async () => true,
					undefined,
					{ now: clock, sliceMs: 20_000, callMs: 5_000 },
				),
			),
			input.now,
			() => input.now + clock() - started,
		);

		if (backlog.published > 0 || backlog.pending > 0 || !backlog.readable)
			input.log("ledger_backlog", {
				readable: backlog.readable,
				published: backlog.published,
				pending: backlog.pending,
				blocked: backlog.blocked,
				oldest: backlog.oldestObservedAt,
				error: backlog.lastError,
			});

		return backlog;
	} catch {
		input.log("ledger_pump_failed", {});

		return null;
	}
}
