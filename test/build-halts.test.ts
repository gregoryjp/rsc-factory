import { describe, expect, it } from "vitest";
import type { ScriptedResult } from "../src/infrastructure/providers/fake-provider.js";
import { buildRun } from "../src/modules/execution/build-run.js";
import { addBudget } from "../src/modules/runs/add-budget.js";
import { currentBlock } from "../src/modules/runs/block-run.js";
import { getRunStatus } from "../src/modules/runs/get-run-status.js";
import {
	type BuildEnv,
	completed,
	createBuildEnv,
	greenImpl,
	redTest,
	task,
} from "./helpers/build-env.js";

const HOUR_MS = 3_600_000;

const costly = (result: ScriptedResult, costUsd: number): ScriptedResult =>
	result.ok ? { ...result, value: { ...result.value, costUsd } } : result;

const build = (env: BuildEnv, options: { force?: boolean } = {}) =>
	buildRun(env.deps, { runId: env.runId, ...options });

const builderRoleCalls = (env: BuildEnv, phase: string) =>
	env.builderCalls().filter((c) => c.systemPrompt.includes(`Role: builder, ${phase} `));

describe("budget exhaustion during build", () => {
	it("stops cleanly before a call it cannot afford, blocks the run, and continues after factory budget --add without repeating calls", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [costly(completed(redTest("add")), 2), costly(completed(greenImpl("add")), 2)],
		});
		env.storage.budgets.setLimit(env.runId, 5);

		const first = await build(env);
		if (!first.ok) throw new Error(first.error.message);
		expect(first.value).toMatchObject({ stoppedBecause: "budget_exhausted", runState: "BLOCKED" });
		expect(env.taskOf("add").state).toBe("READY");
		expect(env.taskOf("add").leaseOwner).toBeNull();
		expect(env.storage.budgets.summary(env.runId)).toMatchObject({
			chargedReportedUsd: 4,
			reservedUsd: 0,
			remainingUsd: 1,
		});
		const block = currentBlock(env.storage, env.runId);
		expect(block).toMatchObject({ cause: "budget_exhausted", priorState: "BUILDING" });
		expect(block?.nextStep).toContain(`factory budget ${env.runId} --add`);
		const status = getRunStatus(env.deps, { runId: env.runId, eventLimit: 3 });
		expect(status.ok && status.value.nextStep).toContain(`factory budget ${env.runId} --add`);

		const refused = await build(env);
		expect(refused).toMatchObject({ ok: false, error: { code: "budget_exhausted" } });

		const added = addBudget(env.deps, { runId: env.runId, addUsd: 10 });
		expect(added).toMatchObject({ ok: true, value: { unblocked: true, state: "BUILDING" } });
		const second = await build(env);
		if (!second.ok) throw new Error(second.error.message);
		expect(second.value.tasks[0]?.outcome).toBe("done");
		expect(second.value.passed).toBe(true);
		expect(builderRoleCalls(env, "red")).toHaveLength(1);
		expect(builderRoleCalls(env, "green")).toHaveLength(1);
	});

	it("never calls the provider when the very first reservation does not fit", async () => {
		const env = await createBuildEnv({ tasks: [task("add")], builder: [] });
		env.storage.budgets.setLimit(env.runId, 2);
		const summary = await build(env);
		expect(summary).toMatchObject({ ok: true, value: { stoppedBecause: "budget_exhausted" } });
		expect(env.builderCalls()).toHaveLength(0);
	});
});

describe("quota exhaustion during build", () => {
	it("does not retry, blocks with quota_wait, refuses before waitUntil unless forced and continues after it", async () => {
		const env = await createBuildEnv({
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
						waitUntil: 1_700_000_000_000 + HOUR_MS,
					},
				},
				completed(greenImpl("add")),
			],
		});
		const first = await build(env);
		if (!first.ok) throw new Error(first.error.message);
		expect(first.value).toMatchObject({ stoppedBecause: "quota_wait", runState: "BLOCKED" });
		expect(builderRoleCalls(env, "green")).toHaveLength(1);
		expect(currentBlock(env.storage, env.runId)).toMatchObject({
			cause: "quota_wait",
			waitUntil: 1_700_000_000_000 + HOUR_MS,
		});

		const early = await build(env);
		expect(early).toMatchObject({ ok: false, error: { code: "quota_wait" } });
		expect(early.ok ? "" : early.error.message).toContain("2023-11-14T23:13:20.000Z");
		expect(builderRoleCalls(env, "green")).toHaveLength(1);

		env.clock.advance(2 * HOUR_MS);
		const later = await build(env);
		if (!later.ok) throw new Error(later.error.message);
		expect(later.value.tasks[0]?.outcome).toBe("done");
		expect(builderRoleCalls(env, "red")).toHaveLength(1);
		expect(builderRoleCalls(env, "green")).toHaveLength(2);
	});

	it("--force continues before waitUntil", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [
				{
					ok: false,
					error: {
						kind: "quota_exhausted",
						retryable: false,
						message: "limit",
						costUsd: null,
						waitUntil: 1_700_000_000_000 + HOUR_MS,
					},
				},
				completed(redTest("add")),
				completed(greenImpl("add")),
			],
		});
		await build(env);
		const forced = await build(env, { force: true });
		if (!forced.ok) throw new Error(forced.error.message);
		expect(forced.value.tasks[0]?.outcome).toBe("done");
	});
});
