import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import manifest from "../package.json" with { type: "json" };
import {
	type AdmissionReceipt,
	type AdmissionStore,
	admitTicket,
	FACTORY_REPOSITORIES,
	type RefusalReason,
} from "../src/admission.ts";
import { formatStageTable } from "../src/stages.ts";
import {
	type EnvLookup,
	type Exec,
	type ExecResult,
	githubRepoFromRemote,
	loadWorkflow,
	MODEL_STAGES,
	type RepoSlug,
	redactCredentials,
	TRUSTED_REF,
	type WorkflowLoad,
} from "../src/workflow.ts";

const STATUS_MESSAGE_TYPE = "factory-status";
const USAGE = "Usage: /factory status | /factory run <issue>";
const FETCH_TIMEOUT_MS = 30_000;
const ISSUE_NUMBER = /^[1-9][0-9]{0,9}$/;

const CONTROLLER_ON_VM =
	"the controller runs on the VM; read it there with status --json --state-dir";

/**
 * The admission store for a dry run. It records nothing, and it cannot see
 * the VM's local switch, so it reports the switch as on and the text says so.
 */
const DRY_RUN_STORE: AdmissionStore = {
	async localSwitch() {
		return "enabled";
	},
	async record() {
		return "recorded";
	},
	async read() {
		return { kind: "absent" };
	},
};

export type WorkflowState =
	| WorkflowLoad
	| { readonly kind: "no_repository"; readonly reason: string };

export type StatusSources = { exec: Exec; env: EnvLookup };

export function readPackageVersion(): string {
	return manifest.version;
}

function describeWorkflow(state: WorkflowState): string[] {
	if (state.kind === "no_repository") {
		return [`workflow    unavailable: ${state.reason}`];
	}

	if (state.kind === "failed") {
		return [
			`workflow    unavailable: ${state.error.kind}: ${state.error.message}`,
			`            ${state.repo} ${state.ref}`,
		];
	}

	const { snapshot } = state;
	const { stages } = snapshot.config;

	const models = MODEL_STAGES.map(
		(stage) => `${stage} ${stages[stage].model}`,
	).join(", ");

	return [
		`workflow    ${snapshot.repo} ${snapshot.ref} ${snapshot.sha.slice(0, 12)} sha256 ${snapshot.digest.slice(0, 12)}`,
		`models      ${models}`,
	];
}

export function formatStatus(version: string, workflow: WorkflowState): string {
	return [
		`pi-herdr-factorio ${version}`,
		"",
		...describeWorkflow(workflow),
		`controller  unavailable: ${CONTROLLER_ON_VM}`,
		"execution   disabled",
		"",
		formatStageTable(),
	].join("\n");
}

type Origin =
	| { readonly kind: "repo"; readonly repo: RepoSlug }
	| { readonly kind: "no_repository"; readonly reason: string };

async function readOrigin(sources: StatusSources): Promise<Origin> {
	let remote: ExecResult;

	try {
		remote = await sources.exec("git", ["remote", "get-url", "origin"]);
	} catch {
		return { kind: "no_repository", reason: "cannot run git" };
	}

	if (remote.code !== 0) {
		return { kind: "no_repository", reason: "no git remote named origin" };
	}

	const repo = githubRepoFromRemote(remote.stdout);

	return repo === null
		? { kind: "no_repository", reason: "origin is not a GitHub repository" }
		: { kind: "repo", repo };
}

export async function readWorkflowState(
	sources: StatusSources,
): Promise<WorkflowState> {
	const origin = await readOrigin(sources);

	if (origin.kind === "no_repository") return origin;

	const { repo } = origin;

	return loadWorkflow({
		exec: sources.exec,
		repo,
		ref: TRUSTED_REF,
		env: sources.env,
	});
}

function reasonText(reason: RefusalReason): string {
	if ("failure" in reason) return `${reason.kind} (${reason.failure.kind})`;

	if ("detail" in reason) return `${reason.kind} (${reason.detail})`;

	if ("permission" in reason) return `${reason.kind} (${reason.permission})`;

	if ("error" in reason) return `${reason.kind} (${reason.error})`;

	return reason.kind;
}

function formatDryRun(receipt: AdmissionReceipt): string {
	const lines = [
		`pi-herdr-factorio ${readPackageVersion()}`,
		"",
		`run         ${receipt.repo}#${receipt.issue} dry run: nothing recorded, no marker written`,
		`decision    ${receipt.decision === "admitted" ? "would be admitted" : "refused"}`,
	];

	if (receipt.decision === "refused") {
		lines.push(`reasons     ${receipt.reasons.map(reasonText).join(", ")}`);
	}

	if (receipt.eventId !== null) {
		lines.push(
			`event       ${receipt.eventId} at ${receipt.eventAt ?? "?"} by ${receipt.actor ?? "?"} (${receipt.actorPermission ?? "?"})`,
		);
	}

	if (receipt.snapshotDigest !== null) {
		lines.push(
			`snapshot    sha256 ${receipt.snapshotDigest.slice(0, 12)} (${receipt.snapshotSource ?? "?"})`,
		);
	}

	if (receipt.baseSha !== null) {
		lines.push(`base        ${receipt.baseSha.slice(0, 12)}`);
	}

	lines.push(
		"",
		"Only the controller on the VM dispatches, with run --issue or serve.",
		"The VM's local switch is not visible here, and this checks it as on.",
	);

	return lines.join("\n");
}

async function dryRunText(
	issueArg: string | undefined,
	sources: StatusSources,
): Promise<string> {
	if (issueArg === undefined || !ISSUE_NUMBER.test(issueArg)) return USAGE;

	const origin = await readOrigin(sources);

	if (origin.kind === "no_repository") {
		return `run         unavailable: ${origin.reason}`;
	}

	const receipt = await admitTicket({
		exec: sources.exec,
		env: sources.env,
		repo: origin.repo,
		issue: Number(issueArg),
		allowlist: FACTORY_REPOSITORIES,
		store: DRY_RUN_STORE,
	});

	return formatDryRun(receipt);
}

export async function factoryCommandText(
	args: string,
	sources: StatusSources,
): Promise<string> {
	const [subcommand = "", issueArg, ...extra] = args.trim().split(/\s+/);

	if (subcommand === "run" && extra.length === 0) {
		return redactCredentials(await dryRunText(issueArg, sources));
	}

	if (subcommand !== "status") return USAGE;

	const state = await readWorkflowState(sources);

	return redactCredentials(formatStatus(readPackageVersion(), state));
}

export function registerFactory(
	pi: Pick<ExtensionAPI, "registerCommand" | "sendMessage" | "exec">,
) {
	pi.registerCommand("factory", {
		description:
			"Software factory: /factory status, /factory run <issue> (admission dry run)",
		handler: async (args, ctx) => {
			const exec: Exec = (command, commandArgs) =>
				pi.exec(command, [...commandArgs], {
					cwd: ctx.cwd,
					timeout: FETCH_TIMEOUT_MS,
				});

			pi.sendMessage({
				customType: STATUS_MESSAGE_TYPE,
				content: await factoryCommandText(args, {
					exec,
					env: (name) => process.env[name],
				}),
				display: true,
			});
		},
	});
}

export default function piHerdrFactorio(pi: ExtensionAPI) {
	registerFactory(pi);
}
