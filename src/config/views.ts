import type { Digest } from "../core/run.ts";
import type { ModelStage, Stage } from "../core/stages.ts";
import type { RepoSlug } from "../trust/platform.ts";
import { reloadWorkflow } from "./load.ts";
import {
	type GitSha,
	type Guidance,
	type ModelId,
	type StageBudget,
	type WorkflowConfig,
	type WorkflowError,
	type WorkflowLoad,
	type WorkflowSnapshot,
	TRUSTED_REF,
} from "./schema.ts";

export type ConfigView = Omit<WorkflowConfig, "workspace"> & {
	readonly workspace: { readonly root: string };
};

type LoadedFields = {
	readonly sha: GitSha;
	readonly digest: Digest;
	readonly valid: true;
	readonly error: null;
};

type FailedFields = {
	readonly sha: GitSha | null;
	readonly digest: Digest | null;
	readonly valid: false;
	readonly error: WorkflowError;
};

type ViewOf<Fields> = {
	readonly repo: RepoSlug;
	readonly ref: string;
	readonly verification: boolean;
	readonly warnings: readonly string[];
} & Fields;

export type LoadView = ViewOf<LoadedFields> | ViewOf<FailedFields>;

type InForce = {
	readonly ref: string;
	readonly sha: GitSha;
	readonly digest: Digest;
};

export type ReloadView =
	| (Omit<ViewOf<LoadedFields>, "warnings"> & {
			readonly outcome: "applied";
			readonly inForce: InForce;
	  })
	| (Omit<ViewOf<FailedFields>, "warnings"> & {
			readonly outcome: "kept";
			readonly inForce: InForce;
	  })
	| (Omit<ViewOf<FailedFields>, "warnings"> & {
			readonly outcome: "unavailable";
			readonly inForce: null;
	  });

export type CheckReport =
	| (ViewOf<LoadedFields> & {
			readonly config: ConfigView;
			readonly guidance: Guidance;
			readonly reload: ReloadView | null;
	  })
	| (ViewOf<FailedFields> & {
			readonly config: null;
			readonly guidance: null;
			readonly reload: ReloadView | null;
	  });

type StatusLimits = {
	readonly pollIntervalMs: number;
	readonly maxConcurrent: number;
	readonly retry: WorkflowConfig["retry"];
	readonly usage: WorkflowConfig["usage"];
	readonly stages: Readonly<Record<Stage, StageBudget>>;
};

type StatusOf<Fields> = {
	readonly package: string;
	readonly version: string;
	readonly repo: RepoSlug;
	readonly ref: string;
	readonly verification: boolean;
} & Fields & {
		readonly warnings: readonly string[];
		readonly executionEnabled: false;
		readonly controller: {
			readonly state: "unavailable";
			readonly reason: string;
		};
	};

export type StatusReport =
	| StatusOf<{
			readonly workflow: "valid";
			readonly workflowSha: GitSha;
			readonly workflowDigest: Digest;
			readonly workflowError: null;
			readonly models: Readonly<Record<ModelStage, ModelId>>;
			readonly seatModels: SeatModels;
			readonly limits: StatusLimits;
			readonly checkpoints: WorkflowConfig["checkpoints"];
	  }>
	| StatusOf<{
			readonly workflow: "invalid";
			readonly workflowSha: GitSha | null;
			readonly workflowDigest: Digest | null;
			readonly workflowError: WorkflowError;
			readonly models: null;
			readonly seatModels: null;
			readonly limits: null;
			readonly checkpoints: null;
	  }>;

export const NO_CONTROLLER = "no controller is installed in this release";

type FailedLoad = Extract<WorkflowLoad, { kind: "failed" }>;

function loadedView(snapshot: WorkflowSnapshot): ViewOf<LoadedFields> {
	return {
		repo: snapshot.repo,
		ref: snapshot.ref,
		sha: snapshot.sha,
		digest: snapshot.digest,
		verification: snapshot.ref !== TRUSTED_REF,
		valid: true,
		error: null,
		warnings: snapshot.warnings,
	};
}

function failedView(load: FailedLoad): ViewOf<FailedFields> {
	return {
		repo: load.repo,
		ref: load.ref,
		sha: load.sha,
		digest: load.digest,
		verification: load.ref !== TRUSTED_REF,
		valid: false,
		error: load.error,
		warnings: [],
	};
}

export function loadView(load: WorkflowLoad): LoadView {
	return load.kind === "loaded" ? loadedView(load.snapshot) : failedView(load);
}

export function configView(config: WorkflowConfig): ConfigView {
	return { ...config, workspace: { root: config.workspace.rootAsWritten } };
}

export function modelsOf(config: WorkflowConfig): Record<ModelStage, ModelId> {
	const { stages } = config;

	return {
		specify: stages.specify.model,
		accept: stages.accept.model,
		build: stages.build.model,
		review: stages.review.model,
	};
}

/** The model each review seat with its own key runs. Shown beside `models.review`, never folded into it. */
export type SeatModels = { readonly "code-review": ModelId };

export function seatModelsOf(config: WorkflowConfig): SeatModels {
	const { review } = config.stages;

	return { "code-review": review.codeReviewModel ?? review.model };
}

function budgetsOf(config: WorkflowConfig): Record<Stage, StageBudget> {
	const { stages } = config;

	return {
		admit: stages.admit.budget,
		specify: stages.specify.budget,
		accept: stages.accept.budget,
		build: stages.build.budget,
		validate: stages.validate.budget,
		review: stages.review.budget,
		land: stages.land.budget,
	};
}

function inForceOf(snapshot: WorkflowSnapshot): InForce {
	return { ref: snapshot.ref, sha: snapshot.sha, digest: snapshot.digest };
}

function reloadView(current: WorkflowLoad, next: WorkflowLoad): ReloadView {
	const reload = reloadWorkflow(
		current.kind === "loaded" ? current.snapshot : null,
		next,
	);

	if (next.kind === "loaded") {
		const { warnings: _warnings, ...view } = loadedView(next.snapshot);

		return { ...view, outcome: "applied", inForce: inForceOf(next.snapshot) };
	}

	const { warnings: _warnings, ...view } = failedView(next);

	if (reload.kind === "unavailable") {
		return { ...view, outcome: "unavailable", inForce: null };
	}

	const inForce = inForceOf(reload.snapshot);

	return {
		...view,
		verification: inForce.ref !== TRUSTED_REF,
		outcome: "kept",
		inForce,
	};
}

export function checkReport(
	load: WorkflowLoad,
	reloadNext: WorkflowLoad | null,
): CheckReport {
	const reloaded = reloadNext === null ? null : reloadView(load, reloadNext);

	if (load.kind === "failed") {
		return {
			...failedView(load),
			config: null,
			guidance: null,
			reload: reloaded,
		};
	}

	const { snapshot } = load;

	return {
		...loadedView(snapshot),
		config: configView(snapshot.config),
		guidance: snapshot.guidance,
		reload: reloaded,
	};
}

export function statusReport(
	load: WorkflowLoad,
	version: string,
): StatusReport {
	const identity = {
		package: "pi-herdr-factorio",
		version,
		repo: load.kind === "loaded" ? load.snapshot.repo : load.repo,
		ref: load.kind === "loaded" ? load.snapshot.ref : load.ref,
	};

	const runtime = {
		executionEnabled: false,
		controller: { state: "unavailable", reason: NO_CONTROLLER },
	} as const;

	if (load.kind === "failed") {
		return {
			...identity,
			verification: load.ref !== TRUSTED_REF,
			workflow: "invalid",
			workflowSha: load.sha,
			workflowDigest: load.digest,
			workflowError: load.error,
			warnings: [],
			...runtime,
			models: null,
			seatModels: null,
			limits: null,
			checkpoints: null,
		};
	}

	const { snapshot } = load;
	const { config } = snapshot;

	return {
		...identity,
		verification: snapshot.ref !== TRUSTED_REF,
		workflow: "valid",
		workflowSha: snapshot.sha,
		workflowDigest: snapshot.digest,
		workflowError: null,
		warnings: snapshot.warnings,
		...runtime,
		models: modelsOf(config),
		seatModels: seatModelsOf(config),
		limits: {
			pollIntervalMs: config.polling.intervalMs,
			maxConcurrent: config.agent.maxConcurrent,
			retry: config.retry,
			usage: config.usage,
			stages: budgetsOf(config),
		},
		checkpoints: config.checkpoints,
	};
}
