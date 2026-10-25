import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	buildCodexArgs,
	createCodexCliProvider,
} from "../src/infrastructure/providers/codex-cli-provider.js";
import type { ProviderRequest } from "../src/infrastructure/providers/provider-port.js";
import { makeTempDir } from "./helpers/env.js";

const FAKE_BINARY = join(import.meta.dirname, "fixtures", "fake-codex.mjs");
const OkSchema = z.strictObject({ ok: z.boolean() });
const OutputSchema = z.object({ status: z.literal("completed"), summary: z.string() });
const AUTH = '{"tokens":{"access_token":"SECRET-ACCESS-TOKEN"}}';
const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);

const request = (overrides: Partial<ProviderRequest> = {}): ProviderRequest => ({
	role: "reviewer-ui",
	provider: "codex",
	prompt: "Review the page",
	systemPrompt: "You are a reviewer",
	jsonSchema: { type: "object", properties: { ok: { type: "boolean" } } },
	model: "gpt-6-astra",
	effort: "medium",
	maxBudgetUsd: 0,
	tools: [],
	cwd: process.cwd(),
	timeoutMs: 5000,
	...overrides,
});

type Dump = {
	argv: string[];
	stdin: string;
	cwd: string;
	envNames: string[];
	codexHome: string;
	home: string;
	homeFiles: string[];
	schema: string | null;
};

const setup = (
	scenario: string,
	options: { auth?: string | null; env?: NodeJS.ProcessEnv } = {},
) => {
	const root = makeTempDir();
	const authFile = join(root, "real-codex", "auth.json");
	if (options.auth !== null) {
		mkdirSync(join(root, "real-codex"));
		writeFileSync(authFile, options.auth ?? AUTH, { mode: 0o600 });
	}
	const workDir = join(root, "work");
	const dumpFile = join(root, "dump.json");
	const provider = createCodexCliProvider({
		binaryPath: FAKE_BINARY,
		authFile,
		workDir,
		now: () => NOW,
		env: {
			PATH: process.env.PATH,
			LANG: "C",
			SECRET_TOKEN: "do-not-leak",
			FAKE_CODEX_SCENARIO: scenario,
			FAKE_CODEX_DUMP: dumpFile,
			...options.env,
		},
		passEnv: ["FAKE_CODEX_SCENARIO", "FAKE_CODEX_DUMP"],
	});
	const dump = (): Dump => JSON.parse(readFileSync(dumpFile, "utf8"));
	return { provider, dump, authFile, workDir, root };
};

describe("CodexCliProvider (fake executable, real event-stream fixtures)", () => {
	it("parses the real_codex_ok stream: validated output, 0 USD, model and token usage", async () => {
		const { provider } = setup("real_ok");
		const result = await provider.invoke(request(), OkSchema);
		expect(result).toEqual({
			ok: true,
			value: {
				output: { ok: true },
				costUsd: 0,
				models: ["gpt-6-astra"],
				usage: {
					inputTokens: 13_584,
					cachedInputTokens: 0,
					outputTokens: 15,
					reasoningOutputTokens: 0,
				},
			},
		});
	});

	it("uses the last agent_message as the output", async () => {
		const { provider } = setup("two_messages");
		const result = await provider.invoke(request(), OutputSchema);
		expect(result).toMatchObject({ ok: true, value: { output: { summary: "last" } } });
	});

	it("passes the documented argv, the prompt over stdin and the schema in a temp file", async () => {
		const { provider, dump } = setup("custom_ok");
		const cwd = makeTempDir();
		await provider.invoke(request({ cwd }), OutputSchema);
		const seen = dump();
		const schemaFile = seen.argv[seen.argv.indexOf("--output-schema") + 1] ?? "";
		expect(seen.argv).toEqual(buildCodexArgs(request({ cwd }), schemaFile));
		expect(seen.argv.slice(0, 1)).toEqual(["exec"]);
		expect(seen.argv).toEqual(
			expect.arrayContaining([
				"--json",
				"--ephemeral",
				"--ignore-user-config",
				"--ignore-rules",
				"--skip-git-repo-check",
				"-m",
				"gpt-6-astra",
				"-C",
				cwd,
			]),
		);
		expect(seen.argv[seen.argv.indexOf("-s") + 1]).toBe("read-only");
		expect(seen.argv).toContain('model_reasoning_effort="medium"');
		expect(seen.argv).toContain('web_search="disabled"');
		for (const feature of [
			"apps",
			"hooks",
			"plugins",
			"multi_agent",
			"computer_use",
			"browser_use",
		]) {
			expect(seen.argv).toContain(feature);
		}
		expect(seen.argv.at(-1)).toBe("-");
		expect(seen.argv.join(" ")).not.toContain("Review the page");
		expect(seen.stdin).toContain("You are a reviewer");
		expect(seen.stdin).toContain("Review the page");
		expect(seen.schema).toBe(JSON.stringify(request().jsonSchema));
		expect(seen.cwd).toBe(cwd);
	});

	it("omits the effort override when none is configured and widens the sandbox only for edit profiles", () => {
		const plain = buildCodexArgs(request({ effort: undefined }), "/s.json");
		expect(plain.join(" ")).not.toContain("model_reasoning_effort");
		expect(plain[plain.indexOf("-s") + 1]).toBe("read-only");
		const edits = buildCodexArgs(request({ permissionMode: "acceptEdits" }), "/s.json");
		expect(edits[edits.indexOf("-s") + 1]).toBe("workspace-write");
		const readOnly = buildCodexArgs(request({ permissionMode: "dontAsk" }), "/s.json");
		expect(readOnly[readOnly.indexOf("-s") + 1]).toBe("read-only");
	});

	it("isolates the call: empty CODEX_HOME with only auth.json, whitelisted env, no leaked secrets", async () => {
		const { provider, dump, authFile, workDir, root } = setup("custom_ok");
		await provider.invoke(request(), OutputSchema);
		const seen = dump();
		expect(seen.codexHome.startsWith(workDir)).toBe(true);
		expect(seen.home).toBe(seen.codexHome);
		expect(seen.homeFiles).toEqual(["auth.json"]);
		expect(seen.envNames).toEqual(
			expect.arrayContaining(["CODEX_HOME", "HOME", "PATH", "LANG", "FAKE_CODEX_SCENARIO"]),
		);
		expect(seen.envNames).not.toContain("SECRET_TOKEN");
		expect(readdirSync(workDir)).toEqual([]);
		expect(readFileSync(authFile, "utf8")).toBe(AUTH);
		expect(statSync(workDir).mode & 0o777).toBe(0o700);
		expect(existsSync(join(root, "real-codex", "config.toml"))).toBe(false);
	});

	it("writes a rotated auth.json back to the source and never echoes auth contents in errors", async () => {
		const rotated = setup("rotate_auth");
		await rotated.provider.invoke(request(), OutputSchema);
		expect(readFileSync(rotated.authFile, "utf8")).toBe('{"rotated":true}');
		expect(statSync(rotated.authFile).mode & 0o777).toBe(0o600);

		const failing = setup("empty_fail");
		const result = await failing.provider.invoke(request(), OutputSchema);
		expect(JSON.stringify(result)).not.toContain("SECRET-ACCESS-TOKEN");
	});

	it("fails without spawning when auth.json is missing", async () => {
		const { provider, root } = setup("custom_ok", { auth: null });
		const result = await provider.invoke(request(), OutputSchema);
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "provider_error", retryable: false },
		});
		expect(existsSync(join(root, "dump.json"))).toBe(false);
	});

	it("maps a rejected model to a non-retryable provider_error carrying the cause", async () => {
		const { provider } = setup("real_model_not_found");
		const result = await provider.invoke(request({ model: "gpt-nonexistent" }), OkSchema);
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "provider_error", retryable: false, costUsd: 0 },
		});
		expect(!result.ok && result.error.message).toContain("model_not_found");
	});

	it("maps a usage limit to quota_exhausted with the parsed reset time", async () => {
		const { provider } = setup("quota");
		const result = await provider.invoke(request(), OutputSchema);
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "quota_exhausted", retryable: false, waitUntil: NOW + 3_600_000 },
		});
	});

	it("maps 429 to a retryable transient rate limit", async () => {
		const { provider } = setup("rate_limit");
		const result = await provider.invoke(request(), OutputSchema);
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "rate_limited_transient", retryable: true },
		});
	});

	it("follows the Claude failure handling for unusable output", async () => {
		for (const scenario of ["bad_json", "schema_mismatch", "no_message", "garbage"]) {
			const { provider } = setup(scenario);
			const result = await provider.invoke(request(), OutputSchema);
			expect(result, scenario).toMatchObject({
				ok: false,
				error: { kind: "invalid_output", retryable: false },
			});
		}
		const { provider } = setup("empty_fail");
		expect(await provider.invoke(request(), OutputSchema)).toMatchObject({
			ok: false,
			error: { kind: "provider_error", retryable: false },
		});
	});

	it("kills the process and reports a retryable timeout", async () => {
		const { provider } = setup("sleep");
		const started = Date.now();
		const result = await provider.invoke(request({ timeoutMs: 300 }), OutputSchema);
		expect(result).toMatchObject({ ok: false, error: { kind: "timeout", retryable: true } });
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	it("reports a missing binary and an aborted signal without retries", async () => {
		const root = makeTempDir();
		mkdirSync(join(root, "c"));
		writeFileSync(join(root, "c", "auth.json"), AUTH);
		const missing = createCodexCliProvider({
			binaryPath: "/nonexistent/codex",
			authFile: join(root, "c", "auth.json"),
			workDir: join(root, "w"),
		});
		expect(await missing.invoke(request(), OutputSchema)).toMatchObject({
			ok: false,
			error: { kind: "provider_error", retryable: false },
		});
		const controller = new AbortController();
		controller.abort();
		const { provider } = setup("custom_ok");
		expect(
			await provider.invoke(request({ signal: controller.signal }), OutputSchema),
		).toMatchObject({
			ok: false,
			error: { kind: "aborted" },
		});
	});
});
