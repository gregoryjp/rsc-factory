import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	buildClaudeArgs,
	createClaudeCliProvider,
} from "../src/infrastructure/providers/claude-cli-provider.js";
import { createFakeProvider } from "../src/infrastructure/providers/fake-provider.js";
import type { ProviderRequest } from "../src/infrastructure/providers/provider-port.js";
import { makeTempDir } from "./helpers/env.js";

const FAKE_BINARY = join(import.meta.dirname, "fixtures", "fake-claude.mjs");
const OutputSchema = z.object({ status: z.literal("completed"), summary: z.string() });

const request = (overrides: Partial<ProviderRequest> = {}): ProviderRequest => ({
	prompt: "Say hi",
	systemPrompt: "You are a test role",
	jsonSchema: { type: "object" },
	model: "sonnet",
	maxBudgetUsd: 0.2,
	tools: [],
	cwd: process.cwd(),
	timeoutMs: 5000,
	...overrides,
});

const providerFor = (scenario: string, extra: Record<string, string> = {}) =>
	createClaudeCliProvider({
		binaryPath: FAKE_BINARY,
		env: { ...process.env, FAKE_SCENARIO: scenario, ...extra },
	});

describe("ClaudeCliProvider (fake executable)", () => {
	it("returns validated structured output, cost and model ids on success", async () => {
		const result = await providerFor("success").invoke(request(), OutputSchema);
		expect(result).toEqual({
			ok: true,
			value: {
				output: { status: "completed", summary: "ok" },
				costUsd: 0.0069,
				models: ["claude-sonnet-5"],
			},
		});
	});

	it("passes the documented argv without a shell", async () => {
		const argvFile = join(makeTempDir(), "argv.json");
		await providerFor("success", { FAKE_ARGV_FILE: argvFile }).invoke(request(), OutputSchema);
		const argv: string[] = JSON.parse(readFileSync(argvFile, "utf8"));
		expect(argv).toEqual(buildClaudeArgs(request()));
		expect(argv.slice(0, 2)).toEqual(["-p", "Say hi"]);
		expect(argv).toEqual(
			expect.arrayContaining([
				"--output-format",
				"json",
				"--no-session-persistence",
				"--strict-mcp-config",
				"--disable-slash-commands",
				"--setting-sources",
				"project",
				"--max-budget-usd",
				"0.2",
			]),
		);
		expect(argv[argv.indexOf("--tools") + 1]).toBe("");
	});

	it("classifies budget exhaustion as budget_exceeded, not retryable", async () => {
		const result = await providerFor("budget").invoke(request(), OutputSchema);
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "budget_exceeded", retryable: false },
		});
	});

	it("classifies malformed stdout as invalid_output (E04 adapter part)", async () => {
		const result = await providerFor("malformed").invoke(request(), OutputSchema);
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "invalid_output", retryable: false },
		});
	});

	it("classifies schema mismatch and missing structured_output as invalid_output", async () => {
		for (const scenario of ["schema_mismatch", "missing_output"]) {
			const result = await providerFor(scenario).invoke(request(), OutputSchema);
			expect(result, scenario).toMatchObject({ ok: false, error: { kind: "invalid_output" } });
		}
	});

	it("kills the process and reports a retryable timeout", async () => {
		const started = Date.now();
		const result = await providerFor("sleep").invoke(request({ timeoutMs: 300 }), OutputSchema);
		expect(result).toMatchObject({ ok: false, error: { kind: "timeout", retryable: true } });
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	it("classifies non-zero exit as provider_error", async () => {
		const result = await providerFor("empty_fail").invoke(request(), OutputSchema);
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "provider_error", retryable: false },
		});
		const apiError = await providerFor("api_error").invoke(request(), OutputSchema);
		expect(apiError).toMatchObject({
			ok: false,
			error: { kind: "provider_error", retryable: false },
		});
	});

	it("marks rate limits as retryable provider errors", async () => {
		const result = await providerFor("rate_limit").invoke(request(), OutputSchema);
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "rate_limited_transient", retryable: true },
		});
	});

	it("reports a missing binary as a non-retryable provider_error", async () => {
		const provider = createClaudeCliProvider({ binaryPath: "/nonexistent/claude" });
		const result = await provider.invoke(request(), OutputSchema);
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "provider_error", retryable: false },
		});
	});

	it("rejects prompts that could be parsed as flags", async () => {
		const result = await providerFor("success").invoke(request({ prompt: "--evil" }), OutputSchema);
		expect(result).toMatchObject({ ok: false, error: { kind: "provider_error" } });
	});
});

const isAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const waitUntilDead = async (pid: number): Promise<boolean> => {
	for (let i = 0; i < 50; i += 1) {
		if (!isAlive(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return false;
};

describe("ClaudeCliProvider hardening", () => {
	it("keeps the reported cost on failures and null when unknown", async () => {
		expect(await providerFor("budget").invoke(request(), OutputSchema)).toMatchObject({
			ok: false,
			error: { kind: "budget_exceeded", costUsd: 1.09 },
		});
		expect(await providerFor("overloaded").invoke(request(), OutputSchema)).toMatchObject({
			ok: false,
			error: { kind: "rate_limited_transient", costUsd: 0.5 },
		});
		expect(await providerFor("empty_fail").invoke(request(), OutputSchema)).toMatchObject({
			ok: false,
			error: { costUsd: null },
		});
		expect(
			await providerFor("sleep").invoke(request({ timeoutMs: 200 }), OutputSchema),
		).toMatchObject({
			ok: false,
			error: { kind: "timeout", costUsd: null },
		});
	});

	it("distinguishes unknown cost (null) from zero cost on success", async () => {
		expect(await providerFor("no_cost").invoke(request(), OutputSchema)).toMatchObject({
			ok: true,
			value: { costUsd: null },
		});
		expect(await providerFor("zero_cost").invoke(request(), OutputSchema)).toMatchObject({
			ok: true,
			value: { costUsd: 0 },
		});
	});

	it("kills the whole process group on timeout even if a grandchild holds stdout", async () => {
		const pidFile = join(makeTempDir(), "pid");
		const started = Date.now();
		const result = await providerFor("grandchild", { FAKE_PID_FILE: pidFile }).invoke(
			request({ timeoutMs: 1000 }),
			OutputSchema,
		);
		expect(result).toMatchObject({ ok: false, error: { kind: "timeout", retryable: true } });
		expect(Date.now() - started).toBeLessThan(5000);
		expect(existsSync(pidFile)).toBe(true);
		const grandchild = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
		expect(await waitUntilDead(grandchild)).toBe(true);
	});

	it("rejects timeouts that exceed the timer limit or are not positive integers", async () => {
		for (const timeoutMs of [2 ** 31, 0, -1, 1.5]) {
			const result = await providerFor("success").invoke(request({ timeoutMs }), OutputSchema);
			expect(result, String(timeoutMs)).toMatchObject({
				ok: false,
				error: { kind: "provider_error", retryable: false },
			});
		}
	});

	it("counts output size in bytes, not characters", async () => {
		const provider = createClaudeCliProvider({
			binaryPath: FAKE_BINARY,
			env: { ...process.env, FAKE_SCENARIO: "big_utf8" },
			maxOutputBytes: 1000,
		});
		expect(await provider.invoke(request(), OutputSchema)).toMatchObject({
			ok: false,
			error: { kind: "provider_error", message: expect.stringContaining("too large") },
		});
	});

	it("matches rate-limit markers as whole tokens only", async () => {
		expect(await providerFor("token_noise").invoke(request(), OutputSchema)).toMatchObject({
			ok: false,
			error: { retryable: false },
		});
		expect(await providerFor("overloaded").invoke(request(), OutputSchema)).toMatchObject({
			ok: false,
			error: { retryable: true },
		});
	});
});

describe("ClaudeCliProvider rate limits and quota", () => {
	const NOW = Date.UTC(2026, 9, 24, 3, 0, 0);
	const quotaProvider = (scenario: string) =>
		createClaudeCliProvider({
			binaryPath: FAKE_BINARY,
			env: { ...process.env, FAKE_SCENARIO: scenario },
			now: () => NOW,
		});

	it("classifies the Pro session limit (HTTP 429) as quota_exhausted with the parsed reset time and no retry", async () => {
		const result = await quotaProvider("session_limit").invoke(request(), OutputSchema);
		expect(result).toMatchObject({
			ok: false,
			error: {
				kind: "quota_exhausted",
				retryable: false,
				waitUntil: Date.UTC(2026, 9, 24, 5, 30, 0),
				costUsd: null,
			},
		});
	});

	it("classifies HTTP 529 overloaded in the result field as transient", async () => {
		expect(await quotaProvider("status_529").invoke(request(), OutputSchema)).toMatchObject({
			ok: false,
			error: { kind: "rate_limited_transient", retryable: true },
		});
	});

	it("aborts an in-flight call through the signal and kills the process group", async () => {
		const controller = new AbortController();
		const started = Date.now();
		const pending = quotaProvider("sleep").invoke(
			request({ signal: controller.signal, timeoutMs: 20_000 }),
			OutputSchema,
		);
		setTimeout(() => controller.abort(), 150);
		const result = await pending;
		expect(result).toMatchObject({ ok: false, error: { kind: "aborted", retryable: false } });
		expect(Date.now() - started).toBeLessThan(5000);
	});

	it("does not even spawn when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		expect(
			await quotaProvider("success").invoke(request({ signal: controller.signal }), OutputSchema),
		).toMatchObject({ ok: false, error: { kind: "aborted", costUsd: 0 } });
	});
});

describe("FakeProvider", () => {
	it("returns scripted results in order and records requests", async () => {
		const provider = createFakeProvider([
			{
				ok: true,
				value: { output: { status: "completed", summary: "one" }, costUsd: 0, models: [] },
			},
			{ ok: false, error: { kind: "timeout", retryable: true, message: "slow", costUsd: null } },
		]);
		const first = await provider.invoke(request(), OutputSchema);
		const second = await provider.invoke(request(), OutputSchema);
		expect(first.ok).toBe(true);
		expect(second).toMatchObject({ ok: false, error: { kind: "timeout" } });
		expect(provider.calls).toHaveLength(2);
		const exhausted = await provider.invoke(request(), OutputSchema);
		expect(exhausted).toMatchObject({ ok: false, error: { kind: "provider_error" } });
	});

	it("validates scripted output against the caller schema", async () => {
		const provider = createFakeProvider([
			{ ok: true, value: { output: { status: "bad" }, costUsd: 0, models: [] } },
		]);
		const result = await provider.invoke(request(), OutputSchema);
		expect(result).toMatchObject({ ok: false, error: { kind: "invalid_output" } });
	});
});
