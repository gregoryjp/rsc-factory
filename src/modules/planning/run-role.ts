import { toJSONSchema, type z } from "zod";
import type { Effort, FallbackConfig, ProviderName, Role } from "../../contracts/planning.js";
import type { GateFailure } from "../../domain/planning/gates.js";
import type {
	ProviderFailure,
	ProviderRequest,
} from "../../infrastructure/providers/provider-port.js";
import { sha256Of } from "../../shared/hash.js";
import { err, fail, ok, type Result } from "../../shared/result.js";
import { guardedInvoke, type Halt } from "../budget/guarded-invoke.js";
import { type PlanDeps, type PlanError, providerModeOf } from "./deps.js";
import { repairPrompt } from "./prompts.js";
import { loadRolesConfig, ROLES_CONFIG_PATH } from "./roles-config.js";

export { ROLES_CONFIG_PATH };
export const COMMON_PROMPT_PATH = "factory/prompts/_common.md";
export const promptPath = (role: Role): string => `factory/prompts/${role}.md`;

export const ROLE_CALL_LIMITS = { timeoutMs: 600_000 } as const;

export type RoleAssets = {
	systemPrompt: string;
	promptFile: string;
	promptHash: string;
	provider: ProviderName;
	model: string;
	effort?: Effort;
	fallback?: FallbackConfig;
};

export const loadRoleAssets = (
	deps: Pick<PlanDeps, "factoryFiles">,
	role: Role,
	file: string = promptPath(role),
): Result<RoleAssets, PlanError> => {
	const common = deps.factoryFiles.read(COMMON_PROMPT_PATH);
	if (!common.ok) return fail("role_assets_unavailable", common.error.message);
	const specific = deps.factoryFiles.read(file);
	if (!specific.ok) return fail("role_assets_unavailable", specific.error.message);
	const roles = loadRolesConfig(deps.factoryFiles);
	if (!roles.ok) return roles;
	const systemPrompt = `${common.value.content.trim()}\n\n${specific.value.content.trim()}`;
	return ok({
		systemPrompt,
		promptFile: file,
		promptHash: sha256Of(systemPrompt),
		provider: roles.value[role].provider,
		model: roles.value[role].model,
		...(roles.value[role].effort === undefined ? {} : { effort: roles.value[role].effort }),
		...(roles.value[role].fallback === undefined ? {} : { fallback: roles.value[role].fallback }),
	});
};

export const providerRouting = (
	assets: Pick<RoleAssets, "provider" | "model" | "effort">,
): Pick<ProviderRequest, "provider" | "model" | "effort"> => ({
	provider: assets.provider,
	model: assets.model,
	...(assets.effort === undefined ? {} : { effort: assets.effort }),
});

export const claimProviderMode = (deps: PlanDeps, runId: string): Result<void, PlanError> => {
	const mode = providerModeOf(deps);
	const run = deps.storage.runs.get(runId);
	if (run?.providerMode === null) deps.storage.runs.setProviderMode(runId, mode);
	else if (run && run.providerMode !== mode) {
		return fail(
			"provider_mode_mismatch",
			`Run ${run.id} started with the ${run.providerMode} provider; refusing to continue with ${mode}`,
		);
	}
	return ok(undefined);
};

export const providerError = (failure: ProviderFailure): PlanError => {
	if (failure.kind === "quota_exhausted") {
		return {
			code: "quota_exhausted",
			message: failure.message,
			waitUntil: failure.waitUntil ?? null,
		};
	}
	if (failure.kind === "aborted") return { code: "run_canceled", message: failure.message };
	return failure.retryable
		? { code: "provider_unavailable", message: failure.message }
		: { code: "provider_failed", message: `${failure.kind}: ${failure.message}` };
};

export const haltError = (halt: Halt): PlanError =>
	halt.kind === "budget_exhausted"
		? {
				code: "budget_exhausted",
				message: halt.message,
				needUsd: halt.needUsd,
				remainingUsd: halt.remainingUsd,
			}
		: { code: halt.kind, message: halt.message };

export type ReadOnlyProfile = {
	tools: readonly string[];
	permissionMode: "dontAsk";
};

export const READ_ONLY_PROFILE: ReadOnlyProfile = {
	tools: ["Read", "Glob", "Grep"],
	permissionMode: "dontAsk",
};

export const callRole = async <Raw, Value>(
	deps: PlanDeps,
	input: {
		runId: string;
		role: Role;
		cwd: string;
		prompt: string;
		schema: z.ZodType<Raw>;
		gate: (raw: Raw) => Result<Value, GateFailure>;
		profile?: ReadOnlyProfile;
	},
): Promise<Result<Value, PlanError>> => {
	const assets = loadRoleAssets(deps, input.role);
	if (!assets.ok) return assets;
	const claimed = claimProviderMode(deps, input.runId);
	if (!claimed.ok) return claimed;
	const jsonSchema = toRequestSchema(input.schema);
	let feedback: string[] = [];

	for (const repair of [false, true]) {
		const called = await guardedInvoke(
			deps,
			{
				runId: input.runId,
				role: input.role,
				repair,
				model: assets.value.model,
				promptFile: assets.value.promptFile,
				promptHash: assets.value.promptHash,
				...(assets.value.fallback === undefined ? {} : { fallback: assets.value.fallback }),
				request: {
					role: input.role,
					prompt: repair ? repairPrompt(input.prompt, feedback) : input.prompt,
					systemPrompt: assets.value.systemPrompt,
					jsonSchema,
					...providerRouting(assets.value),
					tools: input.profile?.tools ?? [],
					cwd: input.cwd,
					timeoutMs: ROLE_CALL_LIMITS.timeoutMs,
					...(input.profile === undefined
						? {}
						: { restricted: true, permissionMode: input.profile.permissionMode }),
				},
			},
			input.schema,
		);
		if (called.halted) return err(haltError(called.halted));
		const { attemptId, result } = called.attempt;
		const finish = (
			outcome: "accepted" | "rejected_schema" | "rejected_gate" | "provider_failed",
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
			if (failure.kind !== "invalid_output") {
				finish("provider_failed", failure.costUsd, failure.message, failure.kind);
				return err(providerError(failure));
			}
			finish("rejected_schema", failure.costUsd, failure.message);
			feedback = [`Output did not match the required schema: ${failure.message}`];
			continue;
		}
		const gated = input.gate(result.value.output);
		if (gated.ok) {
			finish("accepted", result.value.costUsd, null);
			return ok(gated.value);
		}
		finish("rejected_gate", result.value.costUsd, gated.error.message);
		feedback = gated.error.errors;
	}
	return err({
		code: "role_rejected",
		message: `${input.role} output rejected after one repair: ${feedback.join("; ")}`,
		errors: feedback,
	});
};

export const toRequestSchema = (schema: z.ZodType): Record<string, unknown> => {
	const jsonSchema: Record<string, unknown> = { ...toJSONSchema(schema) };
	delete jsonSchema.$schema;
	return jsonSchema;
};
