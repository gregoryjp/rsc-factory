import type { z } from "zod";
import type { Result } from "../../shared/result.js";

export type ProviderRequest = {
	role?: string;
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

export type ProviderSuccess<T> = { output: T; costUsd: number | null; models: string[] };

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
