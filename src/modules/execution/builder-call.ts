import { z } from "zod";
import { ok, type Result } from "../../shared/result.js";
import { guardedInvoke } from "../budget/guarded-invoke.js";
import type { PlanDeps, PlanError } from "../planning/deps.js";
import {
	claimProviderMode,
	haltError,
	loadRoleAssets,
	providerError,
	providerRouting,
	ROLE_CALL_LIMITS,
	toRequestSchema,
} from "../planning/run-role.js";

export const BuilderOutputSchema = z.strictObject({
	status: z.enum(["completed", "blocked"]),
	summary: z.string(),
	testFiles: z.array(z.string()),
});
export type BuilderOutput = z.infer<typeof BuilderOutputSchema>;

export type BuilderKind = "red" | "green" | "findings";

export const BUILDER_PROMPT_FILES: Record<BuilderKind, string> = {
	red: "factory/prompts/builder-red.md",
	green: "factory/prompts/builder-green.md",
	findings: "factory/prompts/builder-repair-findings.md",
};

export const BUILDER_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep"] as const;

export type BuilderCallError = PlanError & { retryable: boolean };

export const callBuilder = async (
	deps: PlanDeps,
	input: { runId: string; kind: BuilderKind; repair: boolean; cwd: string; prompt: string },
): Promise<Result<BuilderOutput, BuilderCallError>> => {
	const assets = loadRoleAssets(deps, "builder", BUILDER_PROMPT_FILES[input.kind]);
	if (!assets.ok) return { ok: false, error: { ...assets.error, retryable: false } };
	const claimed = claimProviderMode(deps, input.runId);
	if (!claimed.ok) return { ok: false, error: { ...claimed.error, retryable: false } };
	const called = await guardedInvoke(
		deps,
		{
			runId: input.runId,
			role: "builder",
			repair: input.repair,
			model: assets.value.model,
			promptFile: assets.value.promptFile,
			promptHash: assets.value.promptHash,
			eventExtras: { phase: input.kind },
			...(assets.value.fallback === undefined ? {} : { fallback: assets.value.fallback }),
			request: {
				role: "builder",
				prompt: input.prompt,
				systemPrompt: assets.value.systemPrompt,
				jsonSchema: toRequestSchema(BuilderOutputSchema),
				...providerRouting(assets.value),
				tools: [...BUILDER_TOOLS],
				cwd: input.cwd,
				timeoutMs: ROLE_CALL_LIMITS.timeoutMs,
				restricted: true,
				permissionMode: "acceptEdits",
			},
		},
		BuilderOutputSchema,
	);
	if (called.halted) return { ok: false, error: { ...haltError(called.halted), retryable: false } };
	const { attemptId, result } = called.attempt;
	const finish = (
		outcome: "accepted" | "rejected_schema" | "provider_failed",
		costUsd: number | null,
		error: string | null,
		failureClass?: string,
	) =>
		deps.storage.roleAttempts.finish(attemptId, {
			outcome,
			costUsd,
			error,
			...(failureClass === undefined ? {} : { failureClass }),
			now: deps.clock.now(),
		});
	if (!result.ok) {
		const failure = result.error;
		finish(
			failure.kind === "invalid_output" ? "rejected_schema" : "provider_failed",
			failure.costUsd,
			failure.message,
			failure.kind,
		);
		const error: PlanError =
			failure.kind === "invalid_output"
				? { code: "builder_invalid_output", message: failure.message }
				: providerError(failure);
		return { ok: false, error: { ...error, retryable: failure.retryable } };
	}
	finish("accepted", result.value.costUsd, null);
	return ok(result.value.output);
};
