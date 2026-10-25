import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RolesConfigSchema } from "../src/contracts/planning.js";
import { fallbackReasonOf } from "../src/domain/provider/fallback.js";
import {
	createFakeProvider,
	type ScriptedResult,
} from "../src/infrastructure/providers/fake-provider.js";
import type {
	ProviderFailure,
	ProviderPort,
	ProviderRequest,
} from "../src/infrastructure/providers/provider-port.js";
import { createRoutingProvider } from "../src/infrastructure/providers/routing-provider.js";
import { callBuilder } from "../src/modules/execution/builder-call.js";
import { callRole } from "../src/modules/planning/run-role.js";
import { getRunStatus } from "../src/modules/runs/get-run-status.js";
import { startRun } from "../src/modules/runs/start-run.js";
import { ok } from "../src/shared/result.js";
import { createFakeClock } from "./helpers/clock.js";
import { makeTempDir, openEnv, REPO_ROOT, writePrd } from "./helpers/env.js";

const Out = z.strictObject({ ok: z.boolean() });

const good = (costUsd: number | null = 0.1): ScriptedResult => ({
	ok: true,
	value: { output: { ok: true }, costUsd, models: ["fake"] },
});

const bad = (over: Partial<ProviderFailure>): ScriptedResult => ({
	ok: false,
	error: { kind: "provider_error", retryable: false, message: "scripted", costUsd: null, ...over },
});

const failure = (over: Partial<ProviderFailure>): ProviderFailure => ({
	kind: "provider_error",
	retryable: false,
	message: "scripted",
	costUsd: null,
	...over,
});

const setup = (
	scripts: { claude?: ScriptedResult[]; codex?: ScriptedResult[] },
	kind: "claude" | "fake" = "claude",
) => {
	const home = makeTempDir();
	const claude = createFakeProvider(scripts.claude ?? []);
	const codex = createFakeProvider(scripts.codex ?? []);
	const base = openEnv(home, createFakeClock());
	const env = {
		...base,
		provider: createRoutingProvider({ claude, codex }) as ProviderPort,
		settings: { ...base.settings, providerKind: kind },
		sleep: async () => undefined,
		random: () => 1,
	};
	const started = startRun(env, {
		prdPath: writePrd(home),
		targetPath: join(makeTempDir(), "product"),
		projectName: "fallback",
		cwd: home,
		forceNew: true,
		deliveryTarget: "local",
	});
	if (!started.ok) throw new Error(started.error.message);
	return { env, claude, codex, runId: started.value.run.id };
};

type Setup = ReturnType<typeof setup>;

const callSpec = (t: Setup, role: "spec-writer" | "reviewer-ux" = "spec-writer") =>
	callRole(t.env, {
		runId: t.runId,
		role,
		cwd: makeTempDir(),
		prompt: "go",
		schema: Out,
		gate: (raw) => ok(raw),
	});

const fallbackEvents = (t: Setup) =>
	t.env.storage.events.list(t.runId, {}).filter((e) => e.type === "provider.fallback");

const QUOTA = bad({
	kind: "quota_exhausted",
	message: "usage limit",
	waitUntil: 1_700_000_900_000,
});

describe("fallback trigger table", () => {
	const cases: [string, ProviderFailure, string | null][] = [
		[
			"binary missing",
			failure({ message: "Could not run provider: spawn claude ENOENT" }),
			"binary_missing",
		],
		["not logged in", failure({ message: "Not logged in - please run /login" }), "not_logged_in"],
		[
			"codex auth file missing",
			failure({ message: "Codex auth file not found; run `codex login`" }),
			"not_logged_in",
		],
		[
			"codex requires docker",
			failure({ message: "codex_requires_docker: docker unavailable; start Docker" }),
			"codex_requires_docker",
		],
		["model not found", failure({ message: "model_not_found: gpt-9" }), "model_not_found"],
		["quota", failure({ kind: "quota_exhausted", message: "limit" }), "quota_exhausted"],
		["generic provider error", failure({ message: "exploded" }), "provider_error"],
		["timeout", failure({ kind: "timeout", retryable: true, message: "slow" }), "timeout"],
		[
			"transient after retries",
			failure({ kind: "rate_limited_transient", retryable: true, message: "429" }),
			"rate_limited",
		],
		["invalid output", failure({ kind: "invalid_output", message: "schema" }), null],
		["budget exceeded", failure({ kind: "budget_exceeded", message: "cap" }), null],
		["aborted", failure({ kind: "aborted", message: "stop" }), null],
	];
	for (const [name, input, expected] of cases) {
		it(`${name} -> ${expected ?? "no fallback"}`, () => {
			expect(fallbackReasonOf(input)).toBe(expected);
		});
	}
});

describe("fallback in guarded invocation", () => {
	it("uses the fallback immediately on quota exhaustion instead of pausing the run", async () => {
		const t = setup({ claude: [QUOTA], codex: [good()] });
		const result = await callSpec(t);
		expect(result).toEqual(ok({ ok: true }));
		expect(t.claude.calls).toHaveLength(1);
		expect(t.codex.calls).toHaveLength(1);
		expect(t.codex.calls[0]).toMatchObject({
			provider: "codex",
			model: "gpt-6-astra",
			effort: "high",
		});
		expect(t.env.storage.runs.get(t.runId)?.state).not.toBe("BLOCKED");
		expect(fallbackEvents(t)).toHaveLength(1);
		expect(fallbackEvents(t)[0]?.payload).toMatchObject({
			role: "spec-writer",
			from: "claude/opus",
			to: "codex/gpt-6-astra",
			reason: "quota_exhausted",
		});
	});

	it("falls back when the primary binary is missing", async () => {
		const t = setup({
			claude: [bad({ message: "Could not run provider: spawn claude ENOENT" })],
			codex: [good()],
		});
		expect((await callSpec(t)).ok).toBe(true);
		expect(fallbackEvents(t)[0]?.payload.reason).toBe("binary_missing");
	});

	it("falls back after the existing retry policy is exhausted", async () => {
		const transient = bad({ kind: "rate_limited_transient", retryable: true, message: "429" });
		const t = setup({ claude: [transient, transient, transient], codex: [good()] });
		expect((await callSpec(t)).ok).toBe(true);
		expect(t.claude.calls).toHaveLength(3);
		expect(t.codex.calls).toHaveLength(1);
		expect(fallbackEvents(t)[0]?.payload.reason).toBe("rate_limited");
	});

	it("does not fall back on invalid model output", async () => {
		const invalid = bad({ kind: "invalid_output", message: "bad schema" });
		const t = setup({ claude: [invalid, invalid], codex: [good()] });
		expect(await callSpec(t)).toMatchObject({ ok: false, error: { code: "role_rejected" } });
		expect(t.codex.calls).toHaveLength(0);
		expect(fallbackEvents(t)).toHaveLength(0);
	});

	it("does not fall back when the run budget is exhausted", async () => {
		const t = setup({ claude: [good()], codex: [good()] });
		t.env.storage.budgets.setLimit(t.runId, 0.01);
		expect(await callSpec(t)).toMatchObject({ ok: false, error: { code: "budget_exhausted" } });
		expect(t.claude.calls).toHaveLength(0);
		expect(t.codex.calls).toHaveLength(0);
		expect(fallbackEvents(t)).toHaveLength(0);
	});

	it("does not fall back on a budget_exceeded provider failure", async () => {
		const t = setup({
			claude: [bad({ kind: "budget_exceeded", message: "cap" })],
			codex: [good()],
		});
		expect((await callSpec(t)).ok).toBe(false);
		expect(t.codex.calls).toHaveLength(0);
	});

	it("is one hop: a failing fallback is not chained and the original quota wait is reported", async () => {
		const t = setup({ claude: [QUOTA], codex: [bad({ message: "codex exploded" })] });
		expect(await callSpec(t)).toMatchObject({
			ok: false,
			error: { code: "quota_exhausted", waitUntil: 1_700_000_900_000 },
		});
		expect(t.claude.calls).toHaveLength(1);
		expect(t.codex.calls).toHaveLength(1);
	});

	it("behaves as today when both providers are unavailable", async () => {
		const t = setup({
			claude: [bad({ message: "Could not run provider: ENOENT" })],
			codex: [bad({ message: "codex_requires_docker: no docker" })],
		});
		expect(await callSpec(t)).toMatchObject({ ok: false, error: { code: "provider_failed" } });
	});

	it("keeps a validation failure of the fallback output on the fallback attempt", async () => {
		const invalid = bad({ kind: "invalid_output", message: "bad schema" });
		const t = setup({ claude: [QUOTA, QUOTA], codex: [invalid, good()] });
		const result = await callSpec(t);
		expect(result).toEqual(ok({ ok: true }));
		expect(t.codex.calls).toHaveLength(2);
	});

	it("charges claude in USD and codex at 0 USD with the call cap counting codex calls", async () => {
		const t = setup({
			claude: [bad({ message: "Could not run provider: ENOENT" })],
			codex: [good(0)],
		});
		await callSpec(t);
		const summary = t.env.storage.budgets.summary(t.runId);
		expect(summary.chargedReportedUsd).toBe(0);
		expect(t.env.storage.budgets.providerCalls(t.runId, "codex")).toBe(1);
		expect(t.env.storage.budgets.providerCalls(t.runId, "claude")).toBe(1);
	});

	it("does nothing with the fake provider kind", async () => {
		const t = setup({ claude: [QUOTA], codex: [good()] }, "fake");
		expect((await callSpec(t)).ok).toBe(false);
		expect(t.codex.calls).toHaveLength(0);
	});

	it("warns (without blocking) when a reviewer falls back to the builder's provider and model", async () => {
		const t = setup({
			codex: [bad({ message: "Could not run provider: ENOENT" })],
			claude: [good()],
		});
		expect((await callSpec(t, "reviewer-ux")).ok).toBe(true);
		const warning = t.env.storage.events.list(t.runId, {}).find((e) => e.type === "roles.warning");
		expect(JSON.stringify(warning?.payload)).toContain("reviewer-ux");
		expect(t.claude.calls[0]).toMatchObject({ provider: "claude", model: "sonnet" });
		expect(t.claude.calls[0]?.effort).toBeUndefined();
	});

	it("surfaces the fallback in the run status", async () => {
		const t = setup({ claude: [QUOTA], codex: [good()] });
		await callSpec(t);
		const status = getRunStatus(t.env, { runId: t.runId, eventLimit: 5 });
		expect(status).toMatchObject({
			ok: true,
			value: {
				fallbacks: [
					{
						role: "spec-writer",
						from: "claude/opus",
						to: "codex/gpt-6-astra",
						reason: "quota_exhausted",
					},
				],
			},
		});
	});

	it("routes a builder fallback to codex with writable edits and the sol model", async () => {
		const t = setup({
			claude: [bad({ message: "Could not run provider: ENOENT" })],
			codex: [
				{
					ok: true,
					value: {
						output: { status: "completed", summary: "s", testFiles: [] },
						costUsd: 0,
						models: ["x"],
					},
				},
			],
		});
		const seen: ProviderRequest[] = [];
		const inner = t.env.provider;
		const env = {
			...t.env,
			provider: {
				invoke: async <T>(request: ProviderRequest, schema: z.ZodType<T>) => {
					seen.push(request);
					return inner.invoke(request, schema);
				},
			} satisfies ProviderPort,
		};
		const result = await callBuilder(env, {
			runId: t.runId,
			kind: "red",
			repair: false,
			cwd: makeTempDir(),
			prompt: "build",
		});
		expect(result.ok).toBe(true);
		expect(seen.at(-1)).toMatchObject({
			provider: "codex",
			model: "gpt-6-sol",
			effort: "medium",
			permissionMode: "acceptEdits",
			restricted: true,
		});
	});
});

describe("roles config fallback", () => {
	const shipped = () =>
		JSON.parse(readFileSync(join(REPO_ROOT, "factory", "config", "roles.json"), "utf8"));

	it("ships the documented fallbacks", () => {
		const roles = RolesConfigSchema.parse(shipped());
		for (const role of ["spec-writer", "architect", "planner", "approver"] as const) {
			expect(roles[role].fallback).toEqual({
				provider: "codex",
				model: "gpt-6-astra",
				effort: "high",
			});
		}
		for (const role of [
			"builder",
			"reviewer-security",
			"reviewer-code",
			"reviewer-legal",
			"review-refuter",
		] as const) {
			expect(roles[role].fallback).toEqual({
				provider: "codex",
				model: "gpt-6-sol",
				effort: "medium",
			});
		}
		for (const role of ["reviewer-ux", "reviewer-ui"] as const) {
			expect(roles[role].fallback).toEqual({ provider: "claude", model: "sonnet" });
		}
	});

	it("rejects a fallback on the same provider, unknown keys and effort on claude", () => {
		const base = shipped();
		const parse = (fallback: unknown) =>
			RolesConfigSchema.safeParse({
				...base,
				planner: { provider: "claude", model: "opus", fallback },
			}).success;
		expect(parse({ provider: "claude", model: "sonnet" })).toBe(false);
		expect(parse({ provider: "codex", model: "gpt-6-sol", extra: 1 })).toBe(false);
		expect(parse({ provider: "codex", model: "" })).toBe(false);
		expect(parse({ provider: "codex", model: "gpt-6-sol", effort: "extreme" })).toBe(false);
		expect(parse({ provider: "codex", model: "gpt-6-sol", effort: "high" })).toBe(true);
		const claudeFallback = {
			...base,
			"reviewer-ux": {
				provider: "codex",
				model: "gpt-6-astra",
				fallback: { provider: "claude", model: "sonnet", effort: "high" },
			},
		};
		expect(RolesConfigSchema.safeParse(claudeFallback).success).toBe(false);
	});
});
