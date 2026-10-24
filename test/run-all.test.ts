import { describe, expect, it } from "vitest";
import type { ScriptedResult } from "../src/infrastructure/providers/fake-provider.js";
import { runAll } from "../src/modules/delivery/run-all.js";
import { addBudget } from "../src/modules/runs/add-budget.js";
import { currentBlock } from "../src/modules/runs/block-run.js";
import { completed, createChainEnv, greenImpl, redTest, task } from "./helpers/build-env.js";

const costly = (result: ScriptedResult, costUsd: number): ScriptedResult =>
	result.ok ? { ...result, value: { ...result.value, costUsd } } : result;

const invoke = (env: ReturnType<typeof createChainEnv>, extra: { budgetUsd?: number } = {}) =>
	runAll(
		{ start: env.start, prepare: env.prepare },
		{
			prdPath: env.prdPath,
			targetPath: env.target,
			projectName: "chain-demo",
			cwd: env.home,
			repairsPerTask: 2,
			...extra,
		},
	);

describe("factory run (one-shot orchestration)", () => {
	it("chains start, plan, build and deliver and ends SUCCEEDED with delivery local", async () => {
		const env = createChainEnv({
			tasks: [task("add")],
			builder: [completed(redTest("add")), completed(greenImpl("add"))],
		});
		const result = await invoke(env);
		if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
		expect(result.value).toMatchObject({
			result: "delivered",
			phases: ["plan", "build", "deliver"],
			reused: false,
			nextCommand: null,
		});
		const run = env.storage.runs.get(result.value.runId);
		expect(run).toMatchObject({ state: "SUCCEEDED", deliveryTarget: "local" });
		expect(result.value.delivery?.mainCommit).toMatch(/^[0-9a-f]{40}$/);
		expect(env.builderCalls()).toHaveLength(2);
	});

	it("is a no-op after delivery: the same PRD and target report the delivered run without new work", async () => {
		const env = createChainEnv({
			tasks: [task("add")],
			builder: [completed(redTest("add")), completed(greenImpl("add"))],
		});
		const first = await invoke(env);
		if (!first.ok) throw new Error(first.error.message);
		const calls = env.scripted.calls.length;
		const second = await invoke(env);
		if (!second.ok) throw new Error(second.error.message);
		expect(second.value).toMatchObject({
			result: "delivered",
			runId: first.value.runId,
			phases: [],
			reused: true,
		});
		expect(second.value.delivery?.alreadyDelivered).toBe(true);
		expect(env.scripted.calls).toHaveLength(calls);
	});

	it("stops cleanly on budget, prints the exact next command, and the same command resumes without repeating calls", async () => {
		const env = createChainEnv({
			tasks: [task("add")],
			builder: [costly(completed(redTest("add")), 2), costly(completed(greenImpl("add")), 2)],
		});
		const first = await invoke(env, { budgetUsd: 5 });
		if (!first.ok) throw new Error(first.error.message);
		const runId = first.value.runId;
		expect(first.value).toMatchObject({ result: "paused_budget", phases: ["plan", "build"] });
		expect(first.value.nextCommand).toContain(`factory budget ${runId} --add`);
		expect(currentBlock(env.storage, runId)?.cause).toBe("budget_exhausted");
		expect(env.builderCalls()).toHaveLength(2);

		const stillBlocked = await invoke(env);
		if (!stillBlocked.ok) throw new Error(stillBlocked.error.message);
		expect(stillBlocked.value).toMatchObject({ result: "paused_budget", runId, reused: true });
		expect(env.builderCalls()).toHaveLength(2);

		const added = addBudget(env.deps, { runId, addUsd: 10 });
		expect(added.ok).toBe(true);
		const resumed = await invoke(env);
		if (!resumed.ok) throw new Error(`${resumed.error.code}: ${resumed.error.message}`);
		expect(resumed.value).toMatchObject({ result: "delivered", runId, reused: true });
		expect(resumed.value.phases).toEqual(["build", "deliver"]);
		expect(env.builderCalls()).toHaveLength(2);
		expect(env.storage.runs.get(runId)?.state).toBe("SUCCEEDED");
	});

	it("waits on provider quota and resumes after waitUntil", async () => {
		const HOUR = 3_600_000;
		const env = createChainEnv({
			tasks: [task("add")],
			builder: [
				completed(redTest("add")),
				{
					ok: false,
					error: {
						kind: "quota_exhausted",
						retryable: false,
						message: "You've hit your session limit",
						costUsd: null,
						waitUntil: 1_700_000_000_000 + HOUR,
					},
				},
				completed(greenImpl("add")),
			],
		});
		const first = await invoke(env);
		if (!first.ok) throw new Error(first.error.message);
		expect(first.value.result).toBe("paused_quota");
		expect(first.value.message).toContain("2023-11-14T23:13:20.000Z");
		const early = await invoke(env);
		expect(early.ok && early.value.result).toBe("paused_quota");
		env.clock.advance(2 * HOUR);
		const later = await invoke(env);
		if (!later.ok) throw new Error(later.error.message);
		expect(later.value).toMatchObject({ result: "delivered", runId: first.value.runId });
	});

	it("stops on a blocked task with the exact commands to continue", async () => {
		const env = createChainEnv({
			tasks: [task("add")],
			builder: [
				{
					ok: true,
					value: {
						output: { status: "blocked", summary: "cannot", testFiles: [] },
						costUsd: null,
						models: ["fake"],
					},
				},
			],
		});
		const result = await invoke(env);
		if (!result.ok) throw new Error(result.error.message);
		expect(result.value.result).toBe("blocked");
		expect(result.value.nextCommand).toContain(`factory status ${result.value.runId}`);
		expect(result.value.message).toContain("add");
	});
});
