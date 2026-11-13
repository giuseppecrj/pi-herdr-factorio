import { builtinTable, type RouteTable } from "../../../host/gateway/routes.ts";
import { EXE_DEV_PLATFORM } from "../../../src/trust/platform.ts";

export function modelTable(
	fallback: string | null = "xai/grok-4.6",
): RouteTable {
	return builtinTable({
		platform: EXE_DEV_PLATFORM,
		stage: "specify",
		runId: "a".repeat(64),
		attempt: 1,
		model: "gpt-6.1-sol",
		fallback,
		modelTokens: 50_000,
		modelRequests: 200,
	});
}

export function anthropicTable(
	input: {
		model?: string;
		fallback?: string | null;
		modelTokens?: number;
	} = {},
): RouteTable {
	return builtinTable({
		platform: EXE_DEV_PLATFORM,
		stage: "accept",
		runId: "a".repeat(64),
		attempt: 1,
		provider: "anthropic",
		model: input.model ?? "claude-sonnet-5-5",
		fallback: input.fallback ?? null,
		modelTokens: input.modelTokens ?? 25_000,
		modelRequests: 200,
	});
}
