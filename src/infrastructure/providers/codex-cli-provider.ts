import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { classifyCodexError } from "../../domain/provider/codex-quota.js";
import type { Result } from "../../shared/result.js";
import { err, ok } from "../../shared/result.js";
import type {
	ProviderFailure,
	ProviderPort,
	ProviderRequest,
	ProviderSuccess,
	TokenUsage,
} from "./provider-port.js";
import { DEFAULT_MAX_OUTPUT_BYTES, MAX_TIMER_MS, runProcess } from "./run-process.js";

const AUTH_FILE_NAME = "auth.json";
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const BASE_ENV_NAMES = ["PATH", "LANG", "LC_ALL", "TMPDIR"] as const;

const DISABLED_FEATURES = [
	"apps",
	"browser_use",
	"browser_use_external",
	"computer_use",
	"hooks",
	"image_generation",
	"multi_agent",
	"plugins",
	"goals",
] as const;

const SANDBOX_BY_PERMISSION: Record<string, string> = {
	acceptEdits: "workspace-write",
};
const DEFAULT_SANDBOX = "read-only";

const UsageSchema = z.object({
	input_tokens: z.number().optional(),
	cached_input_tokens: z.number().optional(),
	output_tokens: z.number().optional(),
	reasoning_output_tokens: z.number().optional(),
});

const EventSchema = z.object({
	type: z.string(),
	item: z.object({ type: z.string(), text: z.string().optional() }).optional(),
	usage: UsageSchema.optional(),
	message: z.string().optional(),
	error: z.object({ message: z.string().optional() }).optional(),
});
type CodexEvent = z.infer<typeof EventSchema>;

type Parsed = {
	lastMessage: string | undefined;
	usage: TokenUsage | undefined;
	failureMessage: string | undefined;
};

export const buildCodexArgs = (request: ProviderRequest, schemaFile: string): string[] => [
	"exec",
	"--json",
	"--ephemeral",
	"--ignore-user-config",
	"--ignore-rules",
	"--skip-git-repo-check",
	...DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
	"-c",
	'web_search="disabled"',
	"-s",
	SANDBOX_BY_PERMISSION[request.permissionMode ?? ""] ?? DEFAULT_SANDBOX,
	"-m",
	request.model,
	...(request.effort === undefined ? [] : ["-c", `model_reasoning_effort="${request.effort}"`]),
	"--output-schema",
	schemaFile,
	"-C",
	request.cwd,
	"-",
];

export const buildCodexPrompt = (request: ProviderRequest): string =>
	`${request.systemPrompt}\n\n---\n\n${request.prompt}`;

const failure = (
	kind: ProviderFailure["kind"],
	retryable: boolean,
	message: string,
	waitUntil?: number | null,
) =>
	err<ProviderFailure>({
		kind,
		retryable,
		message,
		costUsd: 0,
		...(waitUntil === undefined ? {} : { waitUntil }),
	});

const snippet = (text: string): string => text.trim().slice(0, 500);

const parseEvents = (stdout: string): Parsed => {
	const events: CodexEvent[] = stdout.split("\n").flatMap((line) => {
		try {
			const parsed = EventSchema.safeParse(JSON.parse(line));
			return parsed.success ? [parsed.data] : [];
		} catch {
			return [];
		}
	});
	const messages = events.flatMap((event) =>
		event.type === "item.completed" &&
		event.item?.type === "agent_message" &&
		event.item.text !== undefined
			? [event.item.text]
			: [],
	);
	const usageEvent = events.findLast((event) => event.type === "turn.completed")?.usage;
	const failed = events.findLast((event) => event.type === "turn.failed");
	const errored = events.findLast((event) => event.type === "error");
	return {
		lastMessage: messages.at(-1),
		usage:
			usageEvent === undefined
				? undefined
				: {
						inputTokens: usageEvent.input_tokens ?? 0,
						cachedInputTokens: usageEvent.cached_input_tokens ?? 0,
						outputTokens: usageEvent.output_tokens ?? 0,
						reasoningOutputTokens: usageEvent.reasoning_output_tokens ?? 0,
					},
		failureMessage:
			failed === undefined && errored === undefined
				? undefined
				: (failed?.error?.message ?? errored?.message ?? "turn failed"),
	};
};

const failedCall = (message: string, now: number) => {
	const classified = classifyCodexError(message, now);
	if (classified?.kind === "quota_exhausted") {
		return failure("quota_exhausted", false, snippet(message), classified.waitUntil);
	}
	if (classified?.kind === "rate_limited_transient") {
		return failure("rate_limited_transient", true, snippet(message));
	}
	return failure("provider_error", false, snippet(message));
};

const pickEnv = (source: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv =>
	Object.fromEntries(
		names.flatMap((name) => {
			const value = source[name];
			return value === undefined ? [] : [[name, value] as const];
		}),
	);

const writeBackRotatedAuth = (homeAuth: string, authFile: string, original: string): void => {
	try {
		if (!existsSync(homeAuth)) return;
		const current = readFileSync(homeAuth, "utf8");
		if (current === original || current.trim() === "") return;
		JSON.parse(current);
		writeFileSync(authFile, current, { mode: PRIVATE_FILE_MODE });
		chmodSync(authFile, PRIVATE_FILE_MODE);
	} catch {
		return;
	}
};

export const createCodexCliProvider = (config: {
	binaryPath: string;
	authFile: string;
	workDir: string;
	env?: NodeJS.ProcessEnv;
	passEnv?: readonly string[];
	maxOutputBytes?: number;
	now?: () => number;
}): ProviderPort => ({
	invoke: async <T>(
		request: ProviderRequest,
		outputSchema: z.ZodType<T>,
	): Promise<Result<ProviderSuccess<T>, ProviderFailure>> => {
		const now = config.now ?? Date.now;
		if (
			!Number.isInteger(request.timeoutMs) ||
			request.timeoutMs <= 0 ||
			request.timeoutMs > MAX_TIMER_MS
		) {
			return failure(
				"provider_error",
				false,
				`timeoutMs must be an integer between 1 and ${MAX_TIMER_MS}`,
			);
		}
		if (request.signal?.aborted === true) {
			return failure("aborted", false, "The call was aborted before it started");
		}
		if (!existsSync(config.authFile)) {
			return failure(
				"provider_error",
				false,
				"Codex auth file not found; run `codex login` (the file is never read by the factory beyond copying it)",
			);
		}

		mkdirSync(config.workDir, { recursive: true, mode: PRIVATE_DIR_MODE });
		chmodSync(config.workDir, PRIVATE_DIR_MODE);
		const callDir = mkdtempSync(join(config.workDir, "call-"));
		const homeDir = join(callDir, "home");
		const schemaFile = join(callDir, "schema.json");
		const homeAuth = join(homeDir, AUTH_FILE_NAME);
		const originalAuth = readFileSync(config.authFile, "utf8");
		try {
			mkdirSync(homeDir, { mode: PRIVATE_DIR_MODE });
			copyFileSync(config.authFile, homeAuth);
			chmodSync(homeAuth, PRIVATE_FILE_MODE);
			writeFileSync(schemaFile, JSON.stringify(request.jsonSchema));

			const done = await runProcess(config.binaryPath, buildCodexArgs(request, schemaFile), {
				cwd: request.cwd,
				env: {
					...pickEnv(config.env ?? {}, [...BASE_ENV_NAMES, ...(config.passEnv ?? [])]),
					HOME: homeDir,
					CODEX_HOME: homeDir,
				},
				timeoutMs: request.timeoutMs,
				maxOutputBytes: config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
				signal: request.signal,
				input: buildCodexPrompt(request),
			});
			writeBackRotatedAuth(homeAuth, config.authFile, originalAuth);

			if (done.aborted) return failure("aborted", false, "The call was aborted");
			if (done.spawnError !== undefined) {
				return failure("provider_error", false, `Could not run provider: ${done.spawnError}`);
			}
			if (done.timedOut) {
				return failure("timeout", true, `Provider exceeded ${request.timeoutMs} ms`);
			}
			if (done.overflowed) return failure("provider_error", false, "Provider output too large");

			const parsed = parseEvents(done.stdout);
			if (parsed.failureMessage !== undefined) return failedCall(parsed.failureMessage, now());
			if (done.code !== 0) {
				return failedCall(
					`Provider exited with ${done.code}: ${snippet(done.stderr)}`.trim(),
					now(),
				);
			}
			if (parsed.lastMessage === undefined) {
				return failure("invalid_output", false, "Event stream has no agent_message");
			}
			const output = (() => {
				try {
					return outputSchema.safeParse(JSON.parse(parsed.lastMessage));
				} catch {
					return undefined;
				}
			})();
			if (output === undefined) {
				return failure("invalid_output", false, "Final agent_message is not valid JSON");
			}
			if (!output.success) return failure("invalid_output", false, snippet(output.error.message));
			return ok({
				output: output.data,
				costUsd: 0,
				models: [request.model],
				...(parsed.usage === undefined ? {} : { usage: parsed.usage }),
			});
		} finally {
			rmSync(callDir, { recursive: true, force: true });
		}
	},
});
