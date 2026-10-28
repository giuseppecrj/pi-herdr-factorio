import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import manifest from "../package.json" with { type: "json" };
import { formatStageTable } from "../src/stages.ts";
import {
	type EnvLookup,
	type Exec,
	githubRepoFromRemote,
	loadWorkflow,
	MODEL_STAGES,
	NO_CONTROLLER,
	redactCredentials,
	TRUSTED_REF,
	type WorkflowLoad,
} from "../src/workflow.ts";

const STATUS_MESSAGE_TYPE = "factory-status";
const USAGE = "Usage: /factory status";
const FETCH_TIMEOUT_MS = 30_000;

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
		`controller  unavailable: ${NO_CONTROLLER}`,
		"execution   disabled",
		"",
		formatStageTable(),
	].join("\n");
}

export async function readWorkflowState(
	sources: StatusSources,
): Promise<WorkflowState> {
	const remote = await sources.exec("git", ["remote", "get-url", "origin"]);

	if (remote.code !== 0) {
		return { kind: "no_repository", reason: "no git remote named origin" };
	}

	const repo = githubRepoFromRemote(remote.stdout);

	if (repo === null) {
		return {
			kind: "no_repository",
			reason: "origin is not a GitHub repository",
		};
	}

	return loadWorkflow({
		exec: sources.exec,
		repo,
		ref: TRUSTED_REF,
		env: sources.env,
	});
}

export async function factoryCommandText(
	args: string,
	sources: StatusSources,
): Promise<string> {
	const subcommand = args.trim().split(/\s+/)[0] ?? "";

	if (subcommand !== "status") return USAGE;

	const state = await readWorkflowState(sources);

	return redactCredentials(formatStatus(readPackageVersion(), state));
}

export function registerFactory(
	pi: Pick<ExtensionAPI, "registerCommand" | "sendMessage" | "exec">,
) {
	pi.registerCommand("factory", {
		description: "Software factory: /factory status",
		handler: async (args, ctx) => {
			const exec: Exec = async (command, commandArgs) => {
				try {
					return await pi.exec(command, [...commandArgs], {
						cwd: ctx.cwd,
						timeout: FETCH_TIMEOUT_MS,
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : "failed";

					return { stdout: "", stderr: `${command}: ${message}`, code: 127 };
				}
			};

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
