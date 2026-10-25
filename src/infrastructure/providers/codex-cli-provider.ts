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
import { basename, join } from "node:path";
import { z } from "zod";
import { classifyCodexError } from "../../domain/provider/codex-quota.js";
import type { Result } from "../../shared/result.js";
import { err, ok } from "../../shared/result.js";
import { createDockerExec } from "../runner/docker-cli.js";
import {
	buildCodexCleanupArgvs,
	buildCodexNetworkCreateArgv,
	buildCodexRunArgv,
	CONTAINER_MOUNTS,
} from "./codex-docker.js";
import type {
	ProviderFailure,
	ProviderPort,
	ProviderRequest,
	ProviderSuccess,
	TokenUsage,
} from "./provider-port.js";
import {
	type Completed,
	DEFAULT_MAX_OUTPUT_BYTES,
	MAX_TIMER_MS,
	runProcess,
} from "./run-process.js";

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
const CONTAINER_SANDBOX = "danger-full-access";
const DEFAULT_RUN_ID = "adhoc";

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

export const buildCodexArgs = (
	request: ProviderRequest,
	schemaFile: string,
	containerized = false,
): string[] => [
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
	containerized
		? CONTAINER_SANDBOX
		: (SANDBOX_BY_PERMISSION[request.permissionMode ?? ""] ?? DEFAULT_SANDBOX),
	"-m",
	request.model,
	...(request.effort === undefined ? [] : ["-c", `model_reasoning_effort="${request.effort}"`]),
	"--output-schema",
	schemaFile,
	"-C",
	containerized ? CONTAINER_MOUNTS.workspace : request.cwd,
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

const pickEnv = (source: NodeJS.ProcessEnv, names: readonly string[]): Record<string, string> =>
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

export type CodexDockerIsolation = {
	dockerBin: string;
	baseEnv: Readonly<Record<string, string>>;
	image: string;
	vendorDir: string;
	user: { uid: number; gid: number };
	hostHome: string;
	forbiddenRoots: readonly string[];
};

type Launched =
	| { kind: "completed"; done: Completed }
	| { kind: "docker_unavailable"; reason: string };

const requiresDocker = (reason: string) =>
	failure(
		"provider_error",
		false,
		`codex_requires_docker: ${reason}; start Docker or set FACTORY_CODEX_HOST_UNSAFE=1 to run Codex on the host without isolation`,
	);

const runInContainer = async (
	docker: CodexDockerIsolation,
	request: ProviderRequest,
	files: { callDir: string; homeDir: string; schemaFile: string },
	options: { maxOutputBytes: number; env: Readonly<Record<string, string>> },
): Promise<Result<Launched, ProviderFailure>> => {
	const runId = request.runId ?? DEFAULT_RUN_ID;
	const callId = basename(files.callDir).replace(/^call-/, "");
	const argv = buildCodexRunArgv({
		runId,
		callId,
		image: docker.image,
		vendorDir: docker.vendorDir,
		homeDir: files.homeDir,
		schemaFile: files.schemaFile,
		workspace: request.cwd,
		writableWorkspace: request.permissionMode === "acceptEdits",
		user: docker.user,
		hostHome: docker.hostHome,
		forbiddenRoots: docker.forbiddenRoots,
		env: options.env,
		codexArgs: buildCodexArgs(request, CONTAINER_MOUNTS.schema, true),
	});
	if (!argv.ok) return failure("provider_error", false, argv.error.message);
	const exec = createDockerExec({ dockerBin: docker.dockerBin, baseEnv: docker.baseEnv });
	const network = await exec(buildCodexNetworkCreateArgv(runId, callId));
	const networkFailure = !network.ok
		? network.error.message
		: network.value.status === 0
			? undefined
			: snippet(network.value.stderr);
	if (networkFailure !== undefined) {
		await exec(buildCodexCleanupArgvs(runId, callId)[1] ?? []);
		return ok({ kind: "docker_unavailable", reason: networkFailure });
	}
	try {
		const done = await runProcess(docker.dockerBin, argv.value, {
			cwd: files.callDir,
			env: docker.baseEnv,
			timeoutMs: request.timeoutMs,
			maxOutputBytes: options.maxOutputBytes,
			signal: request.signal,
			input: buildCodexPrompt(request),
		});
		return ok({ kind: "completed", done });
	} finally {
		for (const cleanup of buildCodexCleanupArgvs(runId, callId)) await exec(cleanup);
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
	resolveDocker?: () => Promise<Result<CodexDockerIsolation, string>>;
	allowHostUnsafe?: boolean;
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

			const maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
			const runOnHost = () =>
				runProcess(config.binaryPath, buildCodexArgs(request, schemaFile), {
					cwd: request.cwd,
					env: {
						...pickEnv(config.env ?? {}, [...BASE_ENV_NAMES, ...(config.passEnv ?? [])]),
						HOME: homeDir,
						CODEX_HOME: homeDir,
					},
					timeoutMs: request.timeoutMs,
					maxOutputBytes,
					signal: request.signal,
					input: buildCodexPrompt(request),
				});
			const isolation =
				config.resolveDocker === undefined
					? err("Docker isolation is not configured")
					: await config.resolveDocker();
			const launched: Result<Launched, ProviderFailure> = isolation.ok
				? await runInContainer(
						isolation.value,
						request,
						{ callDir, homeDir, schemaFile },
						{ maxOutputBytes, env: pickEnv(config.env ?? {}, ["LANG", "LC_ALL"]) },
					)
				: ok({ kind: "docker_unavailable", reason: isolation.error });
			if (!launched.ok) return launched;
			if (launched.value.kind === "docker_unavailable" && config.allowHostUnsafe !== true) {
				return requiresDocker(launched.value.reason);
			}
			const done = launched.value.kind === "completed" ? launched.value.done : await runOnHost();
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
