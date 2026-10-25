import { z } from "zod";
import { classifyProviderText, parseResetTime } from "../../domain/provider/quota.js";
import type { Result } from "../../shared/result.js";
import { err, ok } from "../../shared/result.js";
import type {
	ProviderFailure,
	ProviderPort,
	ProviderRequest,
	ProviderSuccess,
} from "./provider-port.js";
import { DEFAULT_MAX_OUTPUT_BYTES, MAX_TIMER_MS, runProcess } from "./run-process.js";

const BUDGET_SUBTYPE = "error_max_budget_usd";

const EnvelopeSchema = z.object({
	is_error: z.boolean(),
	subtype: z.string(),
	terminal_reason: z
		.string()
		.nullish()
		.transform((value) => value ?? undefined),
	total_cost_usd: z
		.number()
		.nullish()
		.transform((value) => value ?? undefined),
	structured_output: z.unknown().optional(),
	errors: z
		.array(z.string())
		.nullish()
		.transform((value) => value ?? undefined),
	result: z
		.string()
		.nullish()
		.transform((value) => value ?? undefined),
	api_error_status: z
		.number()
		.nullish()
		.transform((value) => value ?? undefined),
	modelUsage: z
		.record(z.string(), z.unknown())
		.nullish()
		.transform((value) => value ?? undefined),
});
type Envelope = z.infer<typeof EnvelopeSchema>;

const profileArgs = (request: ProviderRequest): string[] => [
	...(request.restricted === true ? ["--restricted"] : []),
	...(request.permissionMode === undefined ? [] : ["--permission-mode", request.permissionMode]),
];

export const buildClaudeArgs = (request: ProviderRequest): string[] => [
	"-p",
	request.prompt,
	"--output-format",
	"json",
	"--json-schema",
	JSON.stringify(request.jsonSchema),
	"--no-session-persistence",
	"--system-prompt",
	request.systemPrompt,
	"--setting-sources",
	"project",
	"--strict-mcp-config",
	"--disable-slash-commands",
	"--safe-mode",
	"--model",
	request.model,
	"--max-budget-usd",
	String(request.maxBudgetUsd),
	"--tools",
	request.tools.join(","),
	...profileArgs(request),
];

const failure = (
	kind: ProviderFailure["kind"],
	retryable: boolean,
	message: string,
	costUsd: number | null = null,
) => err<ProviderFailure>({ kind, retryable, message, costUsd });

const envelopeText = (envelope: Envelope): string =>
	[
		envelope.subtype,
		envelope.terminal_reason ?? "",
		...(envelope.errors ?? []),
		envelope.result ?? "",
		envelope.api_error_status === undefined ? "" : String(envelope.api_error_status),
	].join(" ");

const parseEnvelope = (stdout: string): Envelope | undefined => {
	try {
		const parsed = EnvelopeSchema.safeParse(JSON.parse(stdout));
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
};

const snippet = (text: string): string => text.trim().slice(0, 500);

const validTimeout = (timeoutMs: number): boolean =>
	Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_TIMER_MS;

const rateLimitFailure = (
	text: string,
	now: () => number,
	costUsd: number | null,
): ReturnType<typeof failure> | undefined => {
	const kind = classifyProviderText(text);
	if (kind === "quota_exhausted") {
		return err<ProviderFailure>({
			kind,
			retryable: false,
			message: snippet(text),
			costUsd,
			waitUntil: parseResetTime(text, now()),
		});
	}
	return kind === "rate_limited_transient"
		? failure(kind, true, snippet(text), costUsd)
		: undefined;
};

export const createClaudeCliProvider = (config: {
	binaryPath: string;
	env?: NodeJS.ProcessEnv;
	maxOutputBytes?: number;
	now?: () => number;
}): ProviderPort => ({
	invoke: async <T>(
		request: ProviderRequest,
		outputSchema: z.ZodType<T>,
	): Promise<Result<ProviderSuccess<T>, ProviderFailure>> => {
		const now = config.now ?? Date.now;
		if (request.prompt.startsWith("-")) {
			return failure("provider_error", false, "Prompt must not start with '-'", 0);
		}
		if (!validTimeout(request.timeoutMs)) {
			return failure(
				"provider_error",
				false,
				`timeoutMs must be an integer between 1 and ${MAX_TIMER_MS}`,
				0,
			);
		}
		if (request.signal?.aborted === true) {
			return failure("aborted", false, "The call was aborted before it started", 0);
		}
		const done = await runProcess(config.binaryPath, buildClaudeArgs(request), {
			cwd: request.cwd,
			env: config.env,
			timeoutMs: request.timeoutMs,
			maxOutputBytes: config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
			signal: request.signal,
		});

		if (done.aborted) return failure("aborted", false, "The call was aborted");
		if (done.spawnError !== undefined) {
			return failure("provider_error", false, `Could not run provider: ${done.spawnError}`, 0);
		}
		if (done.timedOut) {
			return failure("timeout", true, `Provider exceeded ${request.timeoutMs} ms`);
		}
		if (done.overflowed) return failure("provider_error", false, "Provider output too large");

		const envelope = parseEnvelope(done.stdout.trim());
		if (envelope && (envelope.is_error || done.code !== 0)) {
			const cost = envelope.total_cost_usd ?? null;
			if (envelope.subtype === BUDGET_SUBTYPE || envelope.terminal_reason === "budget_exhausted") {
				return failure(
					"budget_exceeded",
					false,
					(envelope.errors ?? ["Budget exhausted"]).join("; "),
					cost,
				);
			}
			const limited = rateLimitFailure(`${envelopeText(envelope)} ${done.stderr}`, now, cost);
			if (limited) return limited;
			const detail = [
				envelope.terminal_reason ?? "",
				...(envelope.errors ?? []),
				envelope.result ?? "",
			].join(" ");
			return failure(
				"provider_error",
				false,
				snippet(`${detail} ${done.stderr}`) || envelope.subtype,
				cost,
			);
		}
		if (done.code !== 0) {
			return (
				rateLimitFailure(done.stderr, now, null) ??
				failure(
					"provider_error",
					false,
					`Provider exited with ${done.code}: ${snippet(done.stderr)}`,
				)
			);
		}
		if (!envelope)
			return failure("invalid_output", false, "Provider stdout is not a valid envelope");
		const cost = envelope.total_cost_usd ?? null;
		if (envelope.structured_output === undefined) {
			return failure("invalid_output", false, "Envelope has no structured_output", cost);
		}
		const output = outputSchema.safeParse(envelope.structured_output);
		if (!output.success)
			return failure("invalid_output", false, snippet(output.error.message), cost);
		return ok({
			output: output.data,
			costUsd: cost,
			models: Object.keys(envelope.modelUsage ?? {}),
		});
	},
});
