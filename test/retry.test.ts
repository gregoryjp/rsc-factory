import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildRun } from "../src/modules/execution/build-run.js";
import { MAX_NOTE_CHARS, retryTask } from "../src/modules/execution/retry-task.js";
import { ok, type Result } from "../src/shared/result.js";
import {
	type BuildEnv,
	blockedByBuilder,
	completed,
	createBuildEnv,
	greenImpl,
	redTest,
	task,
} from "./helpers/build-env.js";
import { createFakeClock } from "./helpers/clock.js";
import { openEnv } from "./helpers/env.js";

const run = async (env: BuildEnv) => {
	const result = await buildRun(env.deps, { runId: env.runId });
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.value;
};

const failingAttempt = () => [
	completed(redTest("add")),
	completed(greenImpl("add", 2)),
	completed(greenImpl("add", 3)),
	completed(greenImpl("add", 4)),
];

const retry = (env: BuildEnv, extra: { note?: string; maxRetries?: number } = {}) =>
	retryTask(env.deps, { runId: env.runId, taskKey: "add", ...extra });

describe("factory retry", () => {
	it("moves a retryable BLOCKED task to READY, keeps history and feeds the operator note to the builder", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [...failingAttempt(), completed(redTest("add")), completed(greenImpl("add"))],
		});
		const first = await run(env);
		expect(first.tasks[0]).toMatchObject({ outcome: "blocked", reason: "green_not_reached" });
		const checksBefore = env.storage.checks.listByRun(env.runId).length;

		const retried = retry(env, { note: "Use the existing helper in src/util.js" });
		expect(retried.ok && retried.value).toMatchObject({ key: "add", retries: 1 });
		expect(env.taskOf("add").state).toBe("READY");
		expect(env.buildOf("add")).toBeUndefined();
		expect(env.events("task.retried")[0]?.payload).toMatchObject({
			reason: "green_not_reached",
			note: "Use the existing helper in src/util.js",
			retries: 1,
		});

		const second = await run(env);
		expect(second.tasks.at(-1)).toMatchObject({ key: "add", outcome: "done" });
		expect(env.taskOf("add").state).toBe("DONE");
		expect(env.taskOf("add").attempt).toBeGreaterThan(1);
		const guided = env.builderCalls().slice(4);
		expect(guided.length).toBe(2);
		for (const call of guided) {
			expect(call.prompt).toContain("Operator guidance");
			expect(call.prompt).toContain("Use the existing helper in src/util.js");
		}
		for (const call of env.builderCalls().slice(0, 4)) {
			expect(call.prompt).not.toContain("Operator guidance");
		}
		expect(env.events("task.blocked")).toHaveLength(1);
		expect(env.storage.checks.listByRun(env.runId).length).toBeGreaterThan(checksBefore);
		const branch = spawnSync("git", ["rev-parse", "--verify", "factory/task/add-r1"], {
			cwd: env.target,
			encoding: "utf8",
			env: { PATH: process.env.PATH ?? "" },
		});
		expect(branch.status).toBe(0);
	});

	it("refuses reasons that are not retryable and tasks that are not BLOCKED", async () => {
		const env = await createBuildEnv({ tasks: [task("add")], builder: [blockedByBuilder()] });
		const notBlocked = retry(env);
		expect(!notBlocked.ok && notBlocked.error.code).toBe("retry_not_allowed");
		await run(env);
		const blocked = retry(env);
		expect(!blocked.ok && blocked.error.code).toBe("retry_not_allowed");
		expect(!blocked.ok && blocked.error.message).toContain("builder_blocked");
		expect(env.taskOf("add").state).toBe("BLOCKED");
		const unknown = retryTask(env.deps, { runId: env.runId, taskKey: "zzz" });
		expect(!unknown.ok && unknown.error.code).toBe("task_not_found");
	});

	it("allows tests_tampered and counts it against the limit", async () => {
		const tamper = completed({
			writes: {
				...greenImpl("add").writes,
				"test/add.test.js": "import { test } from 'node:test';\ntest('x', () => {});\n",
			},
		});
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [completed(redTest("add")), tamper, completed(redTest("add")), tamper],
		});
		await run(env);
		expect(env.buildOf("add")?.blockedReason).toBe("tests_tampered");
		expect(retry(env, { maxRetries: 1 }).ok).toBe(true);
		await run(env);
		expect(env.buildOf("add")?.blockedReason).toBe("tests_tampered");
		const limited = retry(env, { maxRetries: 1 });
		expect(!limited.ok && limited.error.code).toBe("retry_limit");
		expect(env.taskOf("add").state).toBe("BLOCKED");
		expect(env.storage.retries.count(env.taskIds.add ?? "")).toBe(1);
	});

	it("defaults to at most 2 retries per task", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [...failingAttempt(), ...failingAttempt(), ...failingAttempt()],
		});
		await run(env);
		expect(retry(env).ok).toBe(true);
		await run(env);
		expect(retry(env).ok).toBe(true);
		await run(env);
		const third = retry(env);
		expect(!third.ok && third.error.code).toBe("retry_limit");
	});

	it("rejects an oversized note", async () => {
		const env = await createBuildEnv({ tasks: [task("add")], builder: failingAttempt() });
		await run(env);
		const result = retry(env, { note: "x".repeat(MAX_NOTE_CHARS + 1) });
		expect(!result.ok && result.error.code).toBe("note_too_long");
	});

	it("re-checks the BLOCKED state and retry count inside the transaction when another connection retries first", async () => {
		const env = await createBuildEnv({ tasks: [task("add")], builder: failingAttempt() });
		await run(env);
		const other = openEnv(env.home, createFakeClock());
		let fired = false;
		const racing = {
			...env.deps,
			storage: {
				...env.deps.storage,
				transaction: <T, E>(work: () => Result<T, E>) => {
					if (fired) return env.deps.storage.transaction(work);
					fired = true;
					const winner = retryTask(
						{ ...env.deps, storage: other.storage, ids: other.ids },
						{ runId: env.runId, taskKey: "add" },
					);
					expect(winner).toEqual(ok(expect.anything()));
					return env.deps.storage.transaction(work);
				},
			},
		};
		const loser = retryTask(racing, { runId: env.runId, taskKey: "add", maxRetries: 5 });
		expect(!loser.ok && loser.error.code).toBe("retry_not_allowed");
		expect(env.storage.retries.count(env.taskIds.add ?? "")).toBe(1);
		expect(env.events("task.retried")).toHaveLength(1);
		other.storage.close();
	});

	it("re-checks the retry limit inside the transaction", async () => {
		const env = await createBuildEnv({ tasks: [task("add")], builder: failingAttempt() });
		await run(env);
		const other = openEnv(env.home, createFakeClock());
		let fired = false;
		const racing = {
			...env.deps,
			storage: {
				...env.deps.storage,
				transaction: <T, E>(work: () => Result<T, E>) => {
					if (fired) return env.deps.storage.transaction(work);
					fired = true;
					other.storage.transaction(() => {
						other.storage.retries.insert({
							runId: env.runId,
							taskId: env.taskIds.add ?? "",
							reason: "green_not_reached",
							note: null,
							now: 1,
						});
						return ok(undefined);
					});
					return env.deps.storage.transaction(work);
				},
			},
		};
		const result = retryTask(racing, { runId: env.runId, taskKey: "add", maxRetries: 1 });
		expect(!result.ok && result.error.code).toBe("retry_limit");
		expect(env.storage.retries.count(env.taskIds.add ?? "")).toBe(1);
		other.storage.close();
	});
});
