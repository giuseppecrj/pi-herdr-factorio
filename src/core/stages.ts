export const STAGE_ORDER = [
	"admit",
	"specify",
	"accept",
	"build",
	"validate",
	"review",
	"land",
] as const;

export type Stage = (typeof STAGE_ORDER)[number];

export const MODEL_STAGES = [
	"specify",
	"accept",
	"build",
	"review",
] as const satisfies readonly Stage[];

export type ModelStage = (typeof MODEL_STAGES)[number];

const MAINTENANCE_STAGE = "maintain";

export const SANDBOX_STAGES = [...STAGE_ORDER, MAINTENANCE_STAGE] as const;

export type SandboxStage = (typeof SANDBOX_STAGES)[number];

export const EXECUTION_STAGES = [
	...MODEL_STAGES,
	MAINTENANCE_STAGE,
] as const satisfies readonly SandboxStage[];

export type ExecutionStage = (typeof EXECUTION_STAGES)[number];

export function isStage(value: string): value is Stage {
	return STAGE_ORDER.some((stage) => stage === value);
}

export function isModelStage(value: string): value is ModelStage {
	return MODEL_STAGES.some((stage) => stage === value);
}
