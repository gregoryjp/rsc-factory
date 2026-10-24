import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { ArchitectOutput, PlannerOutput, SpecOutput } from "../src/contracts/planning.js";
import type { ScriptedResult } from "../src/infrastructure/providers/fake-provider.js";
import type {
	ProviderFailure,
	ProviderPort,
	ProviderRequest,
} from "../src/infrastructure/providers/provider-port.js";
import { createScriptedProvider } from "../src/infrastructure/providers/scripted-provider.js";
import { planRun } from "../src/modules/planning/plan-run.js";
import { addBudget } from "../src/modules/runs/add-budget.js";
import { currentBlock } from "../src/modules/runs/block-run.js";
import { getRunStatus } from "../src/modules/runs/get-run-status.js";
import { resumeRun } from "../src/modules/runs/resume-run.js";
import { startRun } from "../src/modules/runs/start-run.js";
import { ok } from "../src/shared/result.js";
import { createFakeClock } from "./helpers/clock.js";
import { makeTempDir, openEnv, writePrd } from "./helpers/env.js";

const good = (output: unknown, costUsd: number | null = 0.1): ScriptedResult => ({
	ok: true,
	value: { output, costUsd, models: ["fake"] },
});

const failure = (over: Partial<ProviderFailure>): ScriptedResult => ({
	ok: false,
	error: { kind: "provider_error", retryable: false, message: "scripted", costUsd: null, ...over },
});

const spec: SpecOutput = {
	requirements: [
		{ id: "REQ-001", text: "Page", acceptance: ["Renders"], priority: "must", sourceRef: "PRD" },
	],
	assumptions: [],
	contradictions: [],
	outOfScope: [],
	openQuestions: [],
};
const architecture: ArchitectOutput = {
	presetIds: ["static-landing"],
	rationale: "Static",
	omitted: [],
	decisions: [],
};
const plan: PlannerOutput = {
	tasks: [
		{
			key: "page",
			title: "Page",
			requirementIds: ["REQ-001"],
			dependsOn: [],
			acceptance: ["Renders"],
			risk: "low",
			expectedPaths: ["index.html"],
		},
	],
};

type Scripts = Record<"spec-writer" | "architect" | "planner", ScriptedResult[]>;

const setup = (over: Partial<Scripts> = {}, budgetUsd?: number) => {
	const home = makeTempDir();
	const clock = createFakeClock();
	const provider = createScriptedProvider({
		"spec-writer": [good(spec)],
		architect: [good(architecture)],
		planner: [good(plan)],
		...over,
	});
	const base = openEnv(home, clock, { provider });
	const sleeps: number[] = [];
	const env = {
		...base,
		sleep: async (ms: number) => {
			sleeps.push(ms);
		},
		random: () => 1,
	};
	const started = startRun(env, {
		prdPath: writePrd(home),
		targetPath: join(makeTempDir(), "product"),
		projectName: "budget-calls",
		cwd: home,
		forceNew: true,
		deliveryTarget: "local",
		...(budgetUsd === undefined ? {} : { budgetUsd }),
	});
	if (!started.ok) throw new Error(started.error.message);
	return { env, clock, provider, sleeps, runId: started.value.run.id };
};

const roleCalls = (provider: ReturnType<typeof setup>["provider"], role: string) =>
	provider.calls.filter((c) => c.role === role);

describe("budget reservation around every provider call", () => {
	it("passes the per-role ceiling as --max-budget-usd and charges the reported cost", async () => {
		const { env, provider, runId } = setup({ "spec-writer": [good(spec, 0.25)] });
		const result = await planRun(env, { runId });
		expect(result.ok).toBe(true);
		expect(provider.calls.map((c) => [c.role, c.maxBudgetUsd])).toEqual([
			["spec-writer", 1.5],
			["architect", 1.5],
			["planner", 1.5],
		]);
		expect(env.storage.budgets.summary(runId)).toMatchObject({
			chargedReportedUsd: 0.45,
			chargedUnknownUsd: 0,
			reservedUsd: 0,
			remainingUsd: 14.55,
			callsByRole: { "spec-writer": 1, architect: 1, planner: 1 },
		});
	});

	it("charges the full reservation as unknown when the provider reports no cost", async () => {
		const { env, runId } = setup({ "spec-writer": [good(spec, 0.2)] });
		const inner = env.provider;
		const blind = {
			...env,
			provider: {
				invoke: async <T>(request: ProviderRequest, schema: z.ZodType<T>) => {
					const result = await inner.invoke(request, schema);
					return result.ok ? ok({ ...result.value, costUsd: null }) : result;
				},
			} satisfies ProviderPort,
		};
		await planRun(blind, { runId });
		expect(env.storage.budgets.summary(runId)).toMatchObject({
			chargedUnknownUsd: 4.5,
			chargedReportedUsd: 0,
		});
		const attempt = env.storage.roleAttempts.list(runId)[0];
		expect(attempt?.costUsd).toBeNull();
	});

	it("never calls the provider when the remaining budget cannot cover the reservation, and blocks the run with the next step", async () => {
		const { env, provider, runId } = setup({}, 1);
		const result = await planRun(env, { runId });
		expect(result).toMatchObject({ ok: true, value: { state: "BLOCKED" } });
		expect(provider.calls).toHaveLength(0);
		const block = currentBlock(env.storage, runId);
		expect(block).toMatchObject({ cause: "budget_exhausted", priorState: "SPECIFYING" });
		expect(block?.nextStep).toContain(`factory budget ${runId} --add`);
		const status = getRunStatus(env, { runId, eventLimit: 5 });
		expect(status.ok && status.value.nextStep).toContain("budget_exhausted");
	});

	it("factory budget --add unblocks to the prior state and plan continues without repeating completed calls", async () => {
		const { env, provider, runId } = setup({ "spec-writer": [good(spec, 1.2)] }, 2);
		const first = await planRun(env, { runId });
		expect(first).toMatchObject({ ok: true, value: { state: "BLOCKED" } });
		expect(roleCalls(provider, "spec-writer")).toHaveLength(1);
		expect(roleCalls(provider, "architect")).toHaveLength(0);

		const added = addBudget(env, { runId, addUsd: 10 });
		expect(added).toMatchObject({ ok: true, value: { budgetUsd: 12, unblocked: true } });
		expect(env.storage.runs.get(runId)?.state).toBe("PLANNING");

		const second = await planRun(env, { runId });
		expect(second).toMatchObject({ ok: true, value: { state: "PLANNING" } });
		expect(roleCalls(provider, "spec-writer")).toHaveLength(1);
		expect(roleCalls(provider, "architect")).toHaveLength(1);
		expect(roleCalls(provider, "planner")).toHaveLength(1);
	});

	it("rejects non-positive additions and leaves non-budget blocks alone", () => {
		const { env, runId } = setup();
		expect(addBudget(env, { runId, addUsd: 0 })).toMatchObject({ ok: false });
		expect(addBudget(env, { runId, addUsd: 2 })).toMatchObject({
			ok: true,
			value: { budgetUsd: 17, unblocked: false },
		});
	});
});

describe("provider failure taxonomy inside callRole", () => {
	it("retries transient rate limits with full-jitter exponential backoff and records every attempt", async () => {
		const transient = failure({ kind: "rate_limited_transient", retryable: true });
		const { env, provider, sleeps, runId } = setup({
			"spec-writer": [transient, transient, good(spec)],
		});
		const result = await planRun(env, { runId });
		expect(result.ok).toBe(true);
		expect(roleCalls(provider, "spec-writer")).toHaveLength(3);
		expect(sleeps).toEqual([2000, 4000]);
		const attempts = env.storage.roleAttempts.list(runId).filter((a) => a.role === "spec-writer");
		expect(attempts.map((a) => [a.tryNumber, a.outcome, a.failureClass])).toEqual([
			[1, "provider_failed", "rate_limited_transient"],
			[2, "provider_failed", "rate_limited_transient"],
			[3, "accepted", null],
		]);
		expect(env.storage.budgets.summary(runId).retries).toBe(2);
		expect(
			env.storage.events.list(runId, {}).filter((e) => e.type === "provider.retry"),
		).toHaveLength(2);
	});

	it("gives up after three attempts and reports the provider as unavailable without blocking the run", async () => {
		const transient = failure({ kind: "rate_limited_transient", retryable: true });
		const { env, provider, runId } = setup({
			"spec-writer": [transient, transient, transient, good(spec)],
		});
		const result = await planRun(env, { runId });
		expect(result).toMatchObject({ ok: false, error: { code: "provider_unavailable" } });
		expect(roleCalls(provider, "spec-writer")).toHaveLength(3);
		expect(env.storage.runs.get(runId)?.state).toBe("SPECIFYING");
	});

	it("retries a timeout once", async () => {
		const timeout = failure({ kind: "timeout", retryable: true });
		const retried = setup({ "spec-writer": [timeout, good(spec)] });
		expect((await planRun(retried.env, { runId: retried.runId })).ok).toBe(true);
		expect(roleCalls(retried.provider, "spec-writer")).toHaveLength(2);

		const twice = setup({ "spec-writer": [timeout, timeout, good(spec)] });
		expect(await planRun(twice.env, { runId: twice.runId })).toMatchObject({
			ok: false,
			error: { code: "provider_unavailable" },
		});
		expect(roleCalls(twice.provider, "spec-writer")).toHaveLength(2);
	});

	it("does not retry quota exhaustion and blocks the run with waitUntil", async () => {
		const waitUntil = 1_700_000_000_000 + 3 * 3_600_000;
		const quota = failure({ kind: "quota_exhausted", retryable: false, waitUntil });
		const t = setup({ "spec-writer": [quota, good(spec)] });
		const first = await planRun(t.env, { runId: t.runId });
		expect(first).toMatchObject({ ok: true, value: { state: "BLOCKED" } });
		expect(roleCalls(t.provider, "spec-writer")).toHaveLength(1);
		expect(currentBlock(t.env.storage, t.runId)).toMatchObject({
			cause: "quota_wait",
			priorState: "SPECIFYING",
			waitUntil,
		});
	});

	it("resume and plan refuse before waitUntil (unless forced) and continue after it", async () => {
		const clock0 = 1_700_000_000_000;
		const waitUntil = clock0 + 2 * 3_600_000;
		const quota = failure({ kind: "quota_exhausted", retryable: false, waitUntil });
		const t = setup({ "spec-writer": [quota, good(spec)] });
		await planRun(t.env, { runId: t.runId });

		const early = await planRun(t.env, { runId: t.runId });
		expect(early).toMatchObject({ ok: false, error: { code: "quota_wait" } });
		expect(early.ok ? "" : early.error.message).toContain(new Date(waitUntil).toISOString());
		expect(resumeRun(t.env, { runId: t.runId })).toMatchObject({
			ok: false,
			error: { code: "quota_wait" },
		});
		expect(roleCalls(t.provider, "spec-writer")).toHaveLength(1);

		t.clock.advance(3 * 3_600_000);
		const after = await planRun(t.env, { runId: t.runId });
		expect(after).toMatchObject({ ok: true, value: { state: "PLANNING" } });
	});

	it("--force overrides the quota wait", async () => {
		const quota = failure({
			kind: "quota_exhausted",
			retryable: false,
			waitUntil: 1_700_000_000_000 + 9e6,
		});
		const t = setup({ "spec-writer": [quota, good(spec)] });
		await planRun(t.env, { runId: t.runId });
		const forced = await planRun(t.env, { runId: t.runId, force: true });
		expect(forced).toMatchObject({ ok: true, value: { state: "PLANNING" } });
	});

	it("blocks with an unknown waitUntil when the reset time was not parseable", async () => {
		const quota = failure({ kind: "quota_exhausted", retryable: false, waitUntil: null });
		const t = setup({ "spec-writer": [quota, good(spec)] });
		await planRun(t.env, { runId: t.runId });
		expect(currentBlock(t.env.storage, t.runId)).toMatchObject({
			cause: "quota_wait",
			waitUntil: null,
		});
		expect(await planRun(t.env, { runId: t.runId })).toMatchObject({
			ok: true,
			value: { state: "PLANNING" },
		});
	});

	it("status exposes budget, calls per role, retries and the quota wait", async () => {
		const quota = failure({
			kind: "quota_exhausted",
			retryable: false,
			waitUntil: 1_700_000_000_000 + 9e6,
		});
		const transient = failure({ kind: "rate_limited_transient", retryable: true });
		const t = setup({ "spec-writer": [transient, quota] });
		await planRun(t.env, { runId: t.runId });
		const status = getRunStatus(t.env, { runId: t.runId, eventLimit: 5 });
		if (!status.ok) throw new Error("status failed");
		expect(status.value.budget).toMatchObject({
			budgetUsd: 15,
			retries: 1,
			callsByRole: { "spec-writer": 2 },
		});
		expect(status.value.quotaWait).toEqual({ waitUntil: 1_700_000_000_000 + 9e6 });
		expect(status.value.nextStep).toContain("quota_wait");
	});
});
