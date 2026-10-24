import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type {
	ProviderPort,
	ProviderRequest,
} from "../src/infrastructure/providers/provider-port.js";
import { buildRun } from "../src/modules/execution/build-run.js";
import { cancelRun } from "../src/modules/runs/cancel-run.js";
import { err } from "../src/shared/result.js";
import { completed, createBuildEnv, greenImpl, redTest, task } from "./helpers/build-env.js";

const waitFor = async (condition: () => boolean, ms = 5000): Promise<void> => {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("condition not reached in time");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
};

describe("E19 cancellation with active work", () => {
	it("aborts the in-flight provider call, releases leases, settles the reservation and records the effects already performed", async () => {
		const env = await createBuildEnv({ tasks: [task("a"), task("b")], builder: [] });
		const state = { started: false, aborted: false };
		const slow: ProviderPort = {
			invoke: <T>(request: ProviderRequest, _schema: z.ZodType<T>) =>
				new Promise((resolve) => {
					state.started = true;
					request.signal?.addEventListener("abort", () => {
						state.aborted = true;
						resolve(
							err({
								kind: "aborted" as const,
								retryable: false,
								message: "aborted",
								costUsd: null,
							}),
						);
					});
				}),
		};
		const pending = buildRun(
			{ ...env.deps, provider: slow },
			{ runId: env.runId, cancelPollMs: 20 },
		);
		await waitFor(() => state.started);
		const startedAt = Date.now();
		const canceled = cancelRun(env.deps, { runId: env.runId });
		expect(canceled.ok).toBe(true);

		const result = await pending;
		if (!result.ok) throw new Error(result.error.message);
		expect(Date.now() - startedAt).toBeLessThan(3000);
		expect(state.aborted).toBe(true);
		expect(result.value).toMatchObject({ stoppedBecause: "run_canceled", runState: "CANCELED" });
		expect(env.taskOf("a").state).toBe("CANCELED");
		expect(env.taskOf("b").state).toBe("CANCELED");
		expect(env.taskOf("a").leaseOwner).toBeNull();
		expect(env.storage.budgets.openReservations(env.runId)).toHaveLength(0);
		const effects = env.events("build.canceled");
		expect(effects).toHaveLength(1);
		expect(effects[0]?.payload).toMatchObject({ commitsMade: 0, mergesDone: 0 });
	});

	it("stops between steps without another provider call when the run is canceled mid-task, and reports the commits already made", async () => {
		const holder: { env: Awaited<ReturnType<typeof createBuildEnv>> | undefined } = {
			env: undefined,
		};
		const env = await createBuildEnv({
			tasks: [task("a"), task("b")],
			builder: [completed(redTest("a")), completed(greenImpl("a"))],
			hook: (_request, index) => {
				if (index === 1 && holder.env) cancelRun(holder.env.deps, { runId: holder.env.runId });
			},
		});
		holder.env = env;
		const result = await buildRun(env.deps, { runId: env.runId, cancelPollMs: 20 });
		if (!result.ok) throw new Error(result.error.message);
		expect(result.value.stoppedBecause).toBe("run_canceled");
		expect(env.builderCalls()).toHaveLength(2);
		expect(env.taskOf("a").state).toBe("CANCELED");
		const effects = env.events("build.canceled")[0]?.payload;
		expect(effects).toMatchObject({ mergesDone: 0 });
		expect(effects?.commitsMade).toBeGreaterThanOrEqual(1);
	});

	it("kills a long-running check through its process group when the run is canceled", async () => {
		const env = await createBuildEnv({
			tasks: [task("a")],
			builder: [
				completed({
					writes: {
						"test/a.test.js": `import { test } from "node:test";\ntest("slow", async () => { await new Promise((r) => setTimeout(r, 60000)); });\n`,
					},
				}),
			],
			wrapRunner: (runner) => ({
				...runner,
				runCheck: async (input) => {
					writeFileSync(join(input.cwd, "started.flag"), "1");
					setTimeout(() => {
						cancelRun(holder.deps, { runId: holder.runId });
					}, 300);
					return runner.runCheck(input);
				},
			}),
		});
		const holder = { deps: env.deps, runId: env.runId };
		const startedAt = Date.now();
		const result = await buildRun(env.deps, { runId: env.runId, cancelPollMs: 20 });
		if (!result.ok) throw new Error(result.error.message);
		expect(result.value.stoppedBecause).toBe("run_canceled");
		expect(Date.now() - startedAt).toBeLessThan(20_000);
		expect(env.events("check.recorded")).toHaveLength(0);
		expect(env.taskOf("a").state).toBe("CANCELED");
	});
});
