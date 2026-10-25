import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { type Failure, fail, ok, type Result } from "../shared/result.js";

export type ProviderConfig = { kind: "claude" } | { kind: "fake"; fixturesDir: string };

export type RunnerPreference = "docker" | "host" | "auto";

export type Config = {
	factoryHome: string;
	dbFile: string;
	claudeBin: string;
	codexBin: string;
	codexHome: string;
	repoRoot: string;
	provider: ProviderConfig;
	contextPackMaxBytes: number;
	repairsPerTask: number;
	maxTaskRetries: number;
	runnerPreference: RunnerPreference;
	subprocessEnv: Readonly<Record<string, string>>;
};

const SUBPROCESS_ENV_NAMES = [
	"PATH",
	"HOME",
	"TMPDIR",
	"LANG",
	"DOCKER_HOST",
	"DOCKER_CONFIG",
	"DOCKER_CONTEXT",
] as const;

export const DEFAULT_CONTEXT_PACK_MAX_BYTES = 60 * 1024;
export const DEFAULT_REPAIRS_PER_TASK = 2;
export const DEFAULT_MAX_TASK_RETRIES = 2;

const DEFAULT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const EnvSchema = z
	.object({
		FACTORY_HOME: z.string().min(1).optional(),
		FACTORY_CLAUDE_BIN: z.string().min(1).default("claude"),
		FACTORY_CODEX_BIN: z.string().min(1).default("codex"),
		FACTORY_CODEX_HOME: z.string().min(1).optional(),
		FACTORY_PROVIDER: z.enum(["claude", "fake"]).default("claude"),
		FACTORY_FAKE_FIXTURES: z.string().min(1).optional(),
		FACTORY_RUNNER: z.enum(["docker", "host"]).optional(),
		FACTORY_CONTEXT_PACK_MAX_BYTES: z.coerce
			.number()
			.int()
			.positive()
			.default(DEFAULT_CONTEXT_PACK_MAX_BYTES),
		FACTORY_REPAIRS_PER_TASK: z.coerce
			.number()
			.int()
			.min(0)
			.max(5)
			.default(DEFAULT_REPAIRS_PER_TASK),
		FACTORY_MAX_TASK_RETRIES: z.coerce
			.number()
			.int()
			.min(0)
			.max(10)
			.default(DEFAULT_MAX_TASK_RETRIES),
	})
	.superRefine((value, ctx) => {
		if (value.FACTORY_PROVIDER === "fake" && value.FACTORY_FAKE_FIXTURES === undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["FACTORY_FAKE_FIXTURES"],
				message: "FACTORY_PROVIDER=fake requires FACTORY_FAKE_FIXTURES",
			});
		}
	});

export const loadConfig = (
	source: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd(),
	repoRoot: string = DEFAULT_REPO_ROOT,
): Result<Config, Failure<"invalid_config">> => {
	const parsed = EnvSchema.safeParse({
		FACTORY_HOME: source.FACTORY_HOME,
		FACTORY_CLAUDE_BIN: source.FACTORY_CLAUDE_BIN,
		FACTORY_CODEX_BIN: source.FACTORY_CODEX_BIN,
		FACTORY_CODEX_HOME: source.FACTORY_CODEX_HOME,
		FACTORY_PROVIDER: source.FACTORY_PROVIDER,
		FACTORY_FAKE_FIXTURES: source.FACTORY_FAKE_FIXTURES,
		FACTORY_RUNNER: source.FACTORY_RUNNER,
		FACTORY_CONTEXT_PACK_MAX_BYTES: source.FACTORY_CONTEXT_PACK_MAX_BYTES,
		FACTORY_REPAIRS_PER_TASK: source.FACTORY_REPAIRS_PER_TASK,
		FACTORY_MAX_TASK_RETRIES: source.FACTORY_MAX_TASK_RETRIES,
	});
	if (!parsed.success) return fail("invalid_config", parsed.error.message);
	const factoryHome = resolve(cwd, parsed.data.FACTORY_HOME ?? ".factory");
	return ok({
		factoryHome,
		dbFile: join(factoryHome, "factory.db"),
		claudeBin: parsed.data.FACTORY_CLAUDE_BIN,
		codexBin: parsed.data.FACTORY_CODEX_BIN,
		codexHome: parsed.data.FACTORY_CODEX_HOME ?? join(homedir(), ".codex"),
		repoRoot,
		provider:
			parsed.data.FACTORY_PROVIDER === "fake" && parsed.data.FACTORY_FAKE_FIXTURES !== undefined
				? { kind: "fake", fixturesDir: resolve(cwd, parsed.data.FACTORY_FAKE_FIXTURES) }
				: { kind: "claude" },
		contextPackMaxBytes: parsed.data.FACTORY_CONTEXT_PACK_MAX_BYTES,
		repairsPerTask: parsed.data.FACTORY_REPAIRS_PER_TASK,
		maxTaskRetries: parsed.data.FACTORY_MAX_TASK_RETRIES,
		runnerPreference: parsed.data.FACTORY_RUNNER ?? "auto",
		subprocessEnv: Object.fromEntries(
			SUBPROCESS_ENV_NAMES.flatMap((name) => {
				const value = source[name];
				return value === undefined ? [] : [[name, value] as const];
			}),
		),
	});
};
