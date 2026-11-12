import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { type PlatformProfile } from "../../src/trust/platform.ts";
import { GitHubTicketAdapter } from "../../src/github/adapter.ts";
import { checkIdentity } from "../../src/controller/orchestrator.ts";
import { TRUSTED_REF } from "../../src/config/schema.ts";
import { loadWorkflow } from "../../src/config/load.ts";
import { isRepoSlug } from "../../src/trust/platform.ts";
import { acquireLock } from "../controller/lock.ts";
import { controllerMeasure } from "../controller/measurement.ts";
import { lineLog } from "../controller/serve-loop.ts";
import { isDigest } from "../../src/core/run.ts";
import {
	measurementPrimary,
	primaryMetricText,
} from "../../src/views/metrics.ts";
import type { Digest } from "../../src/core/run.ts";
import {
	type MeasurementInput,
	measurementInputOf,
} from "../../src/views/explain.ts";
import { readStageReceipt } from "../sandbox/receipts.ts";
import {
	type CliIo,
	EXIT,
	isPrivateDirectory,
	realRuntime,
	USAGE,
} from "./platform.ts";

export async function runMeasurementCli(
	kind: "score" | "explain",
	argv: readonly string[],
	io: CliIo,
	platform: PlatformProfile,
): Promise<number> {
	let parsed;

	try {
		parsed = parseArgs({
			args: [...argv],
			strict: true,
			allowPositionals: false,
			options: {
				run: { type: "string" },
				repo: { type: "string" },
				"state-dir": { type: "string" },
				scorer: { type: "string" },
				json: { type: "boolean" },
			},
		});
	} catch {
		io.stderr(`${USAGE}\n`);

		return EXIT.usage;
	}

	const v = parsed.values;

	if (
		v.run === undefined ||
		!isDigest(v.run) ||
		v.repo === undefined ||
		!isRepoSlug(v.repo) ||
		!platform.repositories.includes(v.repo) ||
		!v["state-dir"] ||
		(kind === "explain" && v.scorer !== undefined)
	) {
		io.stderr(`${kind} requires --run --repo --state-dir\n${USAGE}\n`);

		return EXIT.usage;
	}

	const stateDir = resolve(v["state-dir"]);
	const primary = measurementPrimary(stateDir, v.repo);
	const runtime = io.runtime ?? realRuntime();
	const log = lineLog(io.stderr, () => runtime.clock.now());
	let release: (() => Promise<void>) | null = null;

	try {
		if (!(await isPrivateDirectory(stateDir)))
			throw new Error("state_unavailable");

		const acquired = await acquireLock({
			stateDir,
			procs: runtime.procs,
			now: () => runtime.clock.now(),
		});

		if (acquired.kind !== "acquired")
			throw new Error("controller_running_or_lock_unavailable");
		release = () => acquired.lock.release();

		const load = await loadWorkflow({
			exec: io.exec,
			repo: v.repo,
			ref: TRUSTED_REF,
			env: io.env,
			platform,
		});

		if (load.kind !== "loaded") throw new Error("trusted_workflow_unavailable");

		if (
			kind === "score" &&
			(
				await checkIdentity(
					new GitHubTicketAdapter({ exec: io.exec, repo: v.repo }),
					platform.controllerLogin,
				)
			).kind !== "ok"
		)
			throw new Error("identity_unavailable");

		const executor = runtime.executor({
			stateDir,
			exec: io.exec,
			log,
			platform,
		});

		if (!(await executor.reconciled()))
			throw new Error("sandbox_recovery_unavailable");

		const report = await controllerMeasure({
			stateDir,
			repo: v.repo,
			exec: io.exec,
			platform,
			executor,
			log,
			signal: runtime.signal,
			kind,
			runId: v.run,
			config: load.snapshot.config,
			scorerId: v.scorer,
		});

		if (v.json) io.stdout(`${JSON.stringify(report, null, 2)}\n`);
		else {
			io.stdout(`${primaryMetricText(report.primary)}\n`);

			if (report.kind === "score")
				io.stdout(
					`${report.event.scorerId}: ${report.event.status}; ${report.event.label ?? "no label"}; score ${report.event.score ?? "unavailable"}; ${report.passing === null ? "not graded" : report.passing ? "passing measurement" : "failing measurement"}\n${report.event.reasoning}\n${report.event.familyNote}\n${report.event.status === "scored" ? "Computed and persisted locally." : "Scoring result persisted locally."} ${report.published ? "Published" : "Publication queued for the controller pump"}; ${report.event.usage.tokens} measurement tokens\nOther scores queued: ${report.queuedScores}\n`,
				);
			else if (report.findings === null)
				io.stdout(
					`explain: ${report.reason}; ${report.usage.tokens} measurement tokens\n`,
				);
			else
				for (const finding of report.findings)
					io.stdout(
						`${finding.text}\nEvidence: ${finding.citations.join(", ")}\n`,
					);
		}

		return report.kind === "score"
			? report.event.status === "scored"
				? EXIT.ok
				: EXIT.invalid
			: report.findings === null
				? EXIT.invalid
				: EXIT.ok;
	} catch (error) {
		const reason =
			error instanceof Error ? error.message : "measurement_unavailable";

		if (v.json)
			io.stdout(
				`${JSON.stringify({ primary, kind, error: reason }, null, 2)}\n`,
			);
		else io.stdout(`${primaryMetricText(primary)}\n${kind}: ${reason}\n`);

		return EXIT.invalid;
	} finally {
		await release?.();
	}
}

export function measurementInput(
	stateDir: string,
	runId: Digest,
	includeChildren = false,
	includeContract = false,
): Promise<MeasurementInput> {
	return measurementInputOf(
		readStageReceipt,
		stateDir,
		runId,
		includeChildren,
		includeContract,
	);
}
