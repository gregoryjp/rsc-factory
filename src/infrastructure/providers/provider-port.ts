import type { z } from "zod";
import type { Result } from "../../shared/result.js";

export type ProviderName = "claude" | "codex";
export type ProviderEffort = "low" | "medium" | "high" | "xhigh";

export type TokenUsage = {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
};

export type ProviderRequest = {
	role?: string;
	runId?: string;
	provider?: ProviderName;
	effort?: ProviderEffort;
	prompt: string;
	systemPrompt: string;
	jsonSchema: Record<string, unknown>;
	model: string;
	maxBudgetUsd: number;
	tools: readonly string[];
	cwd: string;
	timeoutMs: number;
	restricted?: boolean;
	permissionMode?: "acceptEdits" | "dontAsk";
	signal?: AbortSignal;
};

export type ProviderSuccess<T> = {
	output: T;
	costUsd: number | null;
	models: string[];
	usage?: TokenUsage;
};

export type ProviderFailureKind =
	| "timeout"
	| "budget_exceeded"
	| "invalid_output"
	| "rate_limited_transient"
	| "quota_exhausted"
	| "aborted"
	| "provider_error";

export type ProviderFailure = {
	kind: ProviderFailureKind;
	retryable: boolean;
	message: string;
	costUsd: number | null;
	waitUntil?: number | null;
};

export type ProviderPort = {
	invoke: <T>(
		request: ProviderRequest,
		outputSchema: z.ZodType<T>,
	) => Promise<Result<ProviderSuccess<T>, ProviderFailure>>;
};
