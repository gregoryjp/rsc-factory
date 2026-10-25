import type {
	ProviderFailure,
	ProviderFailureKind,
} from "../../infrastructure/providers/provider-port.js";

export type FallbackReason =
	| "binary_missing"
	| "not_logged_in"
	| "codex_requires_docker"
	| "model_not_found"
	| "quota_exhausted"
	| "rate_limited"
	| "timeout"
	| "provider_error";

const REASON_BY_KIND: Record<ProviderFailureKind, FallbackReason | null> = {
	timeout: "timeout",
	budget_exceeded: null,
	invalid_output: null,
	rate_limited_transient: "rate_limited",
	quota_exhausted: "quota_exhausted",
	aborted: null,
	provider_error: "provider_error",
};

const PROVIDER_ERROR_PATTERNS: readonly (readonly [RegExp, FallbackReason])[] = [
	[/codex_requires_docker/i, "codex_requires_docker"],
	[/Could not run provider/i, "binary_missing"],
	[
		/not logged in|\/login|codex login|invalid api key|unauthorized|authentication/i,
		"not_logged_in",
	],
	[
		/model_not_found|model .*(not found|does not exist|not available)|unsupported model/i,
		"model_not_found",
	],
];

export const fallbackReasonOf = (failure: ProviderFailure): FallbackReason | null => {
	const base = REASON_BY_KIND[failure.kind];
	if (base !== "provider_error") return base;
	return PROVIDER_ERROR_PATTERNS.find(([pattern]) => pattern.test(failure.message))?.[1] ?? base;
};

export type FallbackSummary = { role: string; from: string; to: string; reason: string };

export const fallbacksOf = (
	events: readonly { type: string; payload: Record<string, unknown> }[],
): FallbackSummary[] =>
	events
		.filter((event) => event.type === "provider.fallback")
		.map(({ payload }) => ({
			role: String(payload.role),
			from: String(payload.from),
			to: String(payload.to),
			reason: String(payload.reason),
		}));

export const describeFallback = (entry: FallbackSummary): string =>
	`${entry.role}: ${entry.from} -> ${entry.to} (${entry.reason})`;
