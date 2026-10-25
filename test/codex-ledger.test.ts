import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUDGET_CONFIG_PATH, BudgetConfigSchema } from "../src/contracts/budget.js";
import type { ArchitectOutput, PlannerOutput, SpecOutput } from "../src/contracts/planning.js";
import type { ScriptedResult } from "../src/infrastructure/providers/fake-provider.js";
import { createScriptedProvider } from "../src/infrastructure/providers/scripted-provider.js";
import { planRun } from "../src/modules/planning/plan-run.js";
import { ROLES_CONFIG_PATH } from "../src/modules/planning/run-role.js";
import { currentBlock } from "../src/modules/runs/block-run.js";
import { startRun } from "../src/modules/runs/start-run.js";
import { ok } from "../src/shared/result.js";
import { createFakeClock } from "./helpers/clock.js";
import { makeTempDir, openEnv, REPO_ROOT, writePrd } from "./helpers/env.js";

const USAGE = {
	inputTokens: 13584,
	cachedInputTokens: 0,
	outputTokens: 15,
	reasoningOutputTokens: 0,
};

const good = (output: unknown, costUsd: number | null, usage = false): ScriptedResult => ({
	ok: true,
	value: { output, costUsd, models: ["fake"], ...(usage ? { usage: USAGE } : {}) },
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

const withCodexRoles = (path: string, maxCodexCalls: number) => {
	const roles = JSON.parse(readFileSync(join(REPO_ROOT, ROLES_CONFIG_PATH), "utf8"));
	const budget = JSON.parse(readFileSync(join(REPO_ROOT, BUDGET_CONFIG_PATH), "utf8"));
	const overrides: Record<string, string> = {
		[ROLES_CONFIG_PATH]: JSON.stringify({
			...roles,
			"spec-writer": { provider: "codex", model: "gpt-6-astra", effort: "medium" },
			architect: { provider: "codex", model: "gpt-6-sol" },
		}),
		[BUDGET_CONFIG_PATH]: JSON.stringify({ ...budget, maxCodexCallsPerRun: maxCodexCalls }),
	};
	const override = overrides[path];
	return override === undefined ? undefined : ok({ content: override, sha256: "x" });
};

const setup = (maxCodexCalls: number) => {
	const home = makeTempDir();
	const provider = createScriptedProvider({
		"spec-writer": [good(spec, 0, true)],
		architect: [good(architecture, 0)],
		planner: [good(plan, 0.1)],
	});
	const base = openEnv(home, createFakeClock(), { provider });
	const env = {
		...base,
		factoryFiles: {
			read: (path: string) => withCodexRoles(path, maxCodexCalls) ?? base.factoryFiles.read(path),
		},
	};
	const started = startRun(env, {
		prdPath: writePrd(home),
		targetPath: join(makeTempDir(), "product"),
		projectName: "codex-ledger",
		cwd: home,
		forceNew: true,
		deliveryTarget: "local",
	});
	if (!started.ok) throw new Error(started.error.message);
	return { env, provider, runId: started.value.run.id };
};

describe("codex calls in the budget ledger", () => {
	it("routes provider and effort per role, reserves and charges 0 USD, and records tokens", async () => {
		const { env, provider, runId } = setup(12);
		const result = await planRun(env, { runId });
		expect(result).toMatchObject({ ok: true, value: { state: "PLANNING" } });
		expect(
			provider.calls.map((c) => [c.role, c.provider, c.model, c.effort, c.maxBudgetUsd]),
		).toEqual([
			["spec-writer", "codex", "gpt-6-astra", "medium", 0],
			["architect", "codex", "gpt-6-sol", undefined, 0],
			["planner", "claude", "opus", undefined, 0.3],
		]);
		const entries = env.storage.budgets.entries(runId);
		const codexCharges = entries.filter((e) => e.kind === "charge" && e.role !== "planner");
		expect(codexCharges.map((e) => [e.amountUsd, e.basis])).toEqual([
			[0, "reported"],
			[0, "reported"],
		]);
		expect(env.storage.budgets.summary(runId)).toMatchObject({ chargedReportedUsd: 0.1 });
		expect(env.storage.budgets.providerCalls(runId, "codex")).toBe(2);
		expect(env.storage.budgets.providerCalls(runId, "claude")).toBe(1);
		const usage = env.storage.events.list(runId, {}).filter((e) => e.type === "provider.usage");
		expect(usage).toHaveLength(1);
		expect(usage[0]?.payload).toMatchObject({
			role: "spec-writer",
			provider: "codex",
			model: "gpt-6-astra",
			...USAGE,
		});
		const called = env.storage.events.list(runId, {}).find((e) => e.type === "role.called");
		expect(called?.payload).toMatchObject({
			roleProvider: "codex",
			effort: "medium",
			reservedUsd: 0,
		});
	});

	it("stops before the call that would exceed the per-run codex cap and blocks with the next step", async () => {
		const { env, provider, runId } = setup(1);
		const result = await planRun(env, { runId });
		expect(result).toMatchObject({ ok: true, value: { state: "BLOCKED" } });
		expect(provider.calls.map((c) => c.role)).toEqual(["spec-writer"]);
		expect(currentBlock(env.storage, runId)).toMatchObject({ cause: "budget_exhausted" });
		const blocked = env.storage.events
			.list(runId, {})
			.findLast((e) => e.type === "run.state_changed" && e.payload.to === "BLOCKED");
		expect(String(blocked?.payload.reason)).toContain("maxCodexCallsPerRun");
	});
});

describe("reviewer independence warning at plan time", () => {
	it("reports non-independent reviewers in the summary and records the event once", async () => {
		const { env, runId } = setup(12);
		const first = await planRun(env, { runId });
		expect(first.ok && first.value.roleWarnings).toHaveLength(3);
		expect(first.ok && first.value.roleWarnings.join(" ")).toContain("reviewer-security");
		const again = await planRun(env, { runId });
		expect(again.ok && again.value.roleWarnings).toHaveLength(3);
		const events = env.storage.events.list(runId, {}).filter((e) => e.type === "roles.warning");
		expect(events).toHaveLength(1);
		expect(events[0]?.payload.warnings).toHaveLength(3);
	});
});

describe("budget config", () => {
	it("defaults the codex call cap to 12 and ships it in budget.json", () => {
		const shipped = JSON.parse(readFileSync(join(REPO_ROOT, BUDGET_CONFIG_PATH), "utf8"));
		expect(BudgetConfigSchema.parse(shipped).maxCodexCallsPerRun).toBe(12);
		const { maxCodexCallsPerRun: _omitted, ...legacy } = shipped;
		expect(BudgetConfigSchema.parse(legacy).maxCodexCallsPerRun).toBe(12);
		expect(BudgetConfigSchema.safeParse({ ...shipped, maxCodexCallsPerRun: 0 }).success).toBe(
			false,
		);
	});
});
