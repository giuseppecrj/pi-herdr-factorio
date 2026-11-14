import { fileAdmissionStore } from "../../src/trust/admission.ts";
import { type PlatformProfile } from "../../src/trust/platform.ts";
import { GitHubTicketAdapter } from "../../src/github/adapter.ts";
import {
	checkIdentity,
	Orchestrator,
} from "../../src/controller/orchestrator.ts";
import { controllerCadence } from "../controller/cadence.ts";
import { acquireLock } from "../controller/lock.ts";
import {
	controllerMeasurements,
	pumpScoreOutbox,
} from "../controller/measurement.ts";
import { pumpLedgerOutbox } from "../controller/outbox.ts";
import { fileRunFiles } from "../controller/run-files.ts";
import {
	lineLog,
	serveLoop,
	startMetricSnapshots,
} from "../controller/serve-loop.ts";
import { pinVerification, writeStatus } from "../controller/state.ts";
import { refreshFeedGeneration } from "../controller/feed-generation.ts";
import {
	durableUsageOf,
	readDurableAccounting,
	startDurableUsage,
} from "../controller/terminal.ts";
import { type InterventionRead } from "../../src/views/metrics.ts";
import { collectOwnerMetrics } from "./metrics.ts";
import {
	type CliIo,
	EXIT,
	isPrivateDirectory,
	json,
	type Parsed,
	realRuntime,
} from "./platform.ts";

export async function runController(
	parsed: Extract<Parsed, { kind: "controller" }>,
	io: CliIo,
	platform: PlatformProfile,
): Promise<number> {
	const runtime = io.runtime ?? realRuntime();
	const { clock } = runtime;
	const log = lineLog(io.stderr, () => clock.now());

	if (!platform.repositories.includes(parsed.repo)) {
		log("controller_refused", { reason: "repo_not_allowed" });

		return EXIT.invalid;
	}

	if (!(await isPrivateDirectory(parsed.stateDir))) {
		log("controller_refused", { reason: "state_unavailable" });

		return EXIT.invalid;
	}

	if (io.env("GH_HOST") !== platform.ghHost) {
		log("controller_refused", { reason: "gh_host_mismatch" });

		return EXIT.invalid;
	}

	const acquired = await acquireLock({
		stateDir: parsed.stateDir,
		procs: runtime.procs,
		now: () => clock.now(),
	});

	if (acquired.kind === "held") {
		const pid = acquired.holder?.pid ?? null;

		log("controller_running", { pid });

		if (parsed.command !== "serve") {
			io.stdout(json({ error: "controller_running", pid }));
		}

		return EXIT.usage;
	}

	if (acquired.kind === "unavailable") {
		log("controller_refused", { reason: "lock_unavailable" });

		return EXIT.invalid;
	}

	const { lock } = acquired;
	let feedStarted = false;

	try {
		if (acquired.replaced !== null) {
			log("lock_stale_replaced", {
				pid: acquired.replaced.pid,
				since: acquired.replaced.acquiredAt,
			});
		}

		const identity = await checkIdentity(
			new GitHubTicketAdapter({ exec: io.exec, repo: parsed.repo }),
			platform.controllerLogin,
		);

		if (identity.kind !== "ok") {
			log("controller_refused", {
				reason:
					identity.kind === "mismatch"
						? "identity_mismatch"
						: "identity_unavailable",
			});

			return EXIT.invalid;
		}

		const pinned = await pinVerification(
			parsed.stateDir,
			parsed.verificationCap === null
				? null
				: {
						repo: parsed.repo,
						issues: parsed.scope ?? [],
						tokenCap: parsed.verificationCap,
					},
		);

		if (pinned.kind === "refused") {
			log("controller_refused", { reason: pinned.reason });

			return EXIT.invalid;
		}

		if (pinned.kind === "pinned")
			log("verification_cap_pinned", {
				tokenCap: pinned.tokenCap,
				digest: pinned.digest.slice(0, 12),
			});

		const executor = runtime.executor({
			stateDir: parsed.stateDir,
			exec: io.exec,
			log,
			platform,
		});

		const cadence =
			parsed.scope === null
				? controllerCadence({
						stateDir: parsed.stateDir,
						repo: parsed.repo,
						exec: io.exec,
						platform,
						executor,
						log,
						signal: runtime.signal,
					})
				: undefined;

		const measurement = controllerMeasurements({
			stateDir: parsed.stateDir,
			repo: parsed.repo,
			exec: io.exec,
			platform,
			executor,
			log,
			signal: runtime.signal,
		});

		const orchestrator = new Orchestrator({
			exec: io.exec,
			env: io.env,
			platform,
			repo: parsed.repo,
			store: fileAdmissionStore(parsed.stateDir),
			files: fileRunFiles(
				parsed.stateDir,
				runtime.policySource === undefined
					? undefined
					: { ...runtime.policySource, platform },
			),
			executor,
			cadence,
			measurement,
			clock,
			scope: parsed.scope,
			log,
			verification:
				pinned.kind === "pinned"
					? { digest: pinned.digest, tokenCap: pinned.tokenCap }
					: null,
		});

		if (parsed.command === "cadence" && parsed.job !== undefined) {
			const report = await orchestrator.cadenceOnce(parsed.job);
			await cadence?.stop();
			io.stdout(json(report));

			return report.allowed &&
				report.ready &&
				!report.pending &&
				["proposed", "no_delta"].includes(
					report.jobs.find((job) => job.job === parsed.job)?.reason ?? "",
				)
				? EXIT.ok
				: EXIT.invalid;
		}

		const pump = () =>
			pumpLedgerOutbox({
				stateDir: parsed.stateDir,
				exec: io.exec,
				platform,
				repo: parsed.repo,
				now: clock.now(),
				log,
			});

		const scorePump = () =>
			pumpScoreOutbox({
				stateDir: parsed.stateDir,
				repo: parsed.repo,
				exec: io.exec,
				platform,
				log,
			});

		feedStarted = true;

		if (parsed.command === "serve") {
			log("controller_ready", {
				pid: lock.holder.pid,
				repo: parsed.repo,
				scope: parsed.scope?.join("+") ?? "all",
			});

			const interventionCache = new Map<string, InterventionRead>();

			const usage = await startDurableUsage({
				stateDir: parsed.stateDir,
				repo: parsed.repo,
				log,
			});

			const metrics = startMetricSnapshots({
				stateDir: parsed.stateDir,
				collect: () =>
					collectOwnerMetrics(
						parsed.stateDir,
						parsed.repo,
						io,
						interventionCache,
						platform,
					),
				log,
			});

			try {
				await serveLoop({
					orchestrator,
					stateDir: parsed.stateDir,
					platform,
					sleep: runtime.sleep,
					signal: runtime.signal,
					log,
					pump,
					scorePump: () => {
						measurement.retry();

						return scorePump();
					},
					durableUsage: usage.current,
				});
			} finally {
				await Promise.all([
					metrics.stop(),
					usage.stop(),
					cadence?.stop(),
					measurement.stop(),
				]);
			}

			return EXIT.ok;
		}

		const ticked = await orchestrator.tick();

		const report =
			(await orchestrator.drain((ms) =>
				runtime.sleep(ms, new AbortController().signal),
			)) ?? ticked;

		if (
			!(await writeStatus(
				parsed.stateDir,
				report,
				platform,
				durableUsageOf(
					await readDurableAccounting(parsed.stateDir, parsed.repo),
				),
			))
		) {
			log("status_unwritable", {});
		}

		await measurement.stop();
		await pump();
		await scorePump();
		await cadence?.stop();

		io.stdout(json(report));

		if (parsed.command === "tick") return EXIT.ok;

		return report.runs.some((run) => parsed.scope?.includes(run.issue))
			? EXIT.ok
			: EXIT.invalid;
	} finally {
		await lock.release();

		if (
			feedStarted &&
			!(await refreshFeedGeneration({
				stateDir: parsed.stateDir,
				platform,
				now: clock.now(),
			}))
		)
			log("feed_generation_unwritable", {});
	}
}
