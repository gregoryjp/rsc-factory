import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isCheckEvidenceValid } from "../src/domain/checks/evidence.js";
import { buildRun } from "../src/modules/execution/build-run.js";
import { getRunStatus } from "../src/modules/runs/get-run-status.js";
import { resumeRun } from "../src/modules/runs/resume-run.js";
import {
	type BuildEnv,
	blockedByBuilder,
	completed,
	createBuildEnv,
	greenImpl,
	redTest,
	task,
} from "./helpers/build-env.js";
import { commitAll } from "./helpers/exec-env.js";

const gitOut = (cwd: string, args: string[]) =>
	spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { PATH: process.env.PATH ?? "" },
	}).stdout.trim();

const run = async (
	env: BuildEnv,
	options: Parameters<typeof buildRun>[1] extends infer T ? Partial<T> : never = {},
) => {
	const result = await buildRun(env.deps, { runId: env.runId, ...options });
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.value;
};

const happy = (key: string) => [completed(redTest(key)), completed(greenImpl(key))];

describe("builder loop happy path", () => {
	it("observes red, then green, integrates and marks the task DONE with commit-bound evidence", async () => {
		const env = await createBuildEnv({ tasks: [task("add")], builder: happy("add") });
		const summary = await run(env);

		expect(summary.tasks).toEqual([expect.objectContaining({ key: "add", outcome: "done" })]);
		expect(summary.providerCalls).toBe(5);
		expect(summary.runState).toBe("READY_FOR_RELEASE");
		expect(summary.passed).toBe(true);
		expect(env.taskOf("add").state).toBe("DONE");
		expect(env.taskOf("add").leaseOwner).toBeNull();

		const types = env.eventTypes();
		const at = (type: string) => types.indexOf(type as never);
		expect(at("task.leased")).toBeLessThan(at("task.red_observed"));
		expect(at("task.red_observed")).toBeLessThan(at("task.green_observed"));
		expect(at("task.green_observed")).toBeLessThan(at("task.integrated"));

		const head = env.git.headSha(env.target);
		if (!head.ok) throw new Error(head.error.message);
		expect(gitOut(env.target, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("factory/integration");
		const parents = gitOut(env.target, [
			"rev-list",
			"--parents",
			"-n",
			"1",
			"factory/integration",
		]).split(" ");
		expect(parents).toHaveLength(3);
		const taskHead = gitOut(env.target, ["rev-parse", "factory/task/add"]);
		expect(parents).toContain(taskHead);
		expect(gitOut(env.target, ["log", "--format=%s", "factory/task/add"]).split("\n")).toEqual([
			"feat(add): Task add",
			"test(add): add failing tests",
			"chore: scaffold from node-test",
		]);

		const checks = env.storage.checks
			.listByRun(env.runId)
			.filter((c) => c.taskId === env.taskIds.add);
		expect(checks.map((c) => [c.exitCode === 0, c.commitSha])).toEqual([
			[false, expect.any(String)],
			[true, taskHead],
			[true, head.value],
		]);
		expect(checks[0]?.commitSha).toBe(gitOut(env.target, ["rev-parse", "factory/task/add~1"]));
		const integrationCheck = checks[2];
		if (!integrationCheck) throw new Error("no integration check");
		expect(isCheckEvidenceValid(integrationCheck, head.value)).toBe(true);
		expect(isCheckEvidenceValid(checks[1] ?? integrationCheck, head.value)).toBe(false);
		expect(env.events("task.integrated")[0]?.payload).toMatchObject({
			integrationCommit: head.value,
			checkId: integrationCheck.id,
		});
		expect(env.storage.checks.listByRun(env.runId).at(-1)?.commitSha).toBe(head.value);
		expect(existsSync(join(env.home, "runs", env.runId, "worktrees", "add"))).toBe(false);
	});

	it("gives the builder the restricted profile in the task worktree and never Bash", async () => {
		const env = await createBuildEnv({ tasks: [task("add")], builder: happy("add") });
		await run(env);
		const calls = env.builderCalls();
		expect(calls).toHaveLength(2);
		for (const call of calls) {
			expect(call).toMatchObject({
				restricted: true,
				permissionMode: "acceptEdits",
				tools: ["Read", "Edit", "Write", "Glob", "Grep"],
				cwd: join(env.home, "runs", env.runId, "worktrees", "add"),
			});
			expect(JSON.stringify(call.tools)).not.toContain("Bash");
		}
		expect(calls[0]?.systemPrompt).toContain("Role: builder, red phase");
		expect(calls[1]?.systemPrompt).toContain("Role: builder, green and repair phase");
		expect(calls[0]?.prompt).toContain("add works");
	});
});

describe("E05 failing tests never advance", () => {
	it("blocks the task after exactly 1 red + 1 green + 2 repair builder calls and leaves integration untouched", async () => {
		const wrong = completed(greenImpl("add", 2));
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [
				completed(redTest("add")),
				wrong,
				completed(greenImpl("add", 3)),
				completed(greenImpl("add", 4)),
			],
		});
		const summary = await run(env);
		expect(env.builderCalls()).toHaveLength(4);
		expect(summary.tasks[0]).toMatchObject({
			key: "add",
			outcome: "blocked",
			reason: "green_not_reached",
		});
		expect(env.taskOf("add").state).toBe("BLOCKED");
		expect(env.events("task.integrated")).toHaveLength(0);
		expect(env.git.headSha(env.target)).toEqual({ ok: true, value: env.bootstrapSha });
		expect(summary.passed).toBe(false);
		expect(summary.runState).toBe("BUILDING");
		const shas = env.storage.checks.listByRun(env.runId).map((c) => c.commitSha);
		expect(new Set(shas).size).toBe(shas.length);
		expect(env.buildOf("add")).toMatchObject({
			phase: "blocked",
			blockedReason: "green_not_reached",
			repairs: 2,
		});
		expect(env.events("task.blocked")[0]?.payload).toMatchObject({ reason: "green_not_reached" });
	});

	it("feeds the failure tail back to the repair call and passes after a repair, re-checking the new head", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [
				completed(redTest("add")),
				completed(greenImpl("add", 2)),
				completed(greenImpl("add", 1)),
			],
		});
		const summary = await run(env);
		expect(summary.tasks[0]?.outcome).toBe("done");
		expect(env.builderCalls()[2]?.prompt).toContain("exit code 1");
		expect(env.builderCalls()[2]?.prompt).toContain("strictly equal");
		const checks = env.storage.checks
			.listByRun(env.runId)
			.filter((c) => c.taskId === env.taskIds.add);
		expect(checks.map((c) => c.exitCode === 0)).toEqual([false, false, true, true]);
		expect(checks[1]?.commitSha).not.toBe(checks[2]?.commitSha);
	});
});

describe("red must be observed", () => {
	it("repairs once when the tests pass immediately, then blocks", async () => {
		const passingTest = (body: string) =>
			completed({
				writes: {
					"test/add.test.js": `import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("add", () => { ${body}; });\n`,
				},
			});
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [passingTest("assert.equal(1, 1)"), passingTest("assert.equal(2, 2)")],
		});
		const summary = await run(env);
		expect(env.builderCalls()).toHaveLength(2);
		expect(env.builderCalls()[1]?.prompt).toContain("red_not_observed");
		expect(summary.tasks[0]).toMatchObject({ outcome: "blocked", reason: "red_not_observed" });
		expect(env.events("task.red_observed")).toHaveLength(0);
	});
});

describe("tests tampered and protected changes", () => {
	it("blocks when the green phase edits a test written in the red commit", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [
				completed(redTest("add")),
				completed({
					writes: {
						...greenImpl("add").writes,
						"test/add.test.js": "import { test } from 'node:test';\ntest('x', () => {});\n",
					},
				}),
			],
		});
		const summary = await run(env);
		expect(summary.tasks[0]).toMatchObject({ outcome: "blocked", reason: "tests_tampered" });
		expect(env.builderCalls()).toHaveLength(2);
		expect(env.git.headSha(env.target)).toEqual({ ok: true, value: env.bootstrapSha });
	});

	it("blocks when the green phase deletes a red test", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [
				completed(redTest("add")),
				completed({ ...greenImpl("add"), deletes: ["test/add.test.js"] }),
			],
		});
		const summary = await run(env);
		expect(summary.tasks[0]).toMatchObject({ outcome: "blocked", reason: "tests_tampered" });
	});

	it("blocks a package.json scripts edit and records task.protected_change", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [
				completed(redTest("add")),
				completed({
					writes: {
						...greenImpl("add").writes,
						"package.json": JSON.stringify({
							name: "p",
							type: "module",
							scripts: { test: "true", check: "true" },
						}),
					},
				}),
			],
		});
		const summary = await run(env);
		expect(summary.tasks[0]).toMatchObject({ outcome: "blocked", reason: "protected_change" });
		expect(env.events("task.protected_change")[0]?.payload).toMatchObject({
			paths: ["package.json"],
			severity: "blocked",
		});
	});

	it("only flags tsconfig changes for review and persists requiresReview", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [
				completed(redTest("add")),
				completed({ writes: { ...greenImpl("add").writes, "tsconfig.json": "{}\n" } }),
			],
		});
		const summary = await run(env);
		expect(summary.tasks[0]?.outcome).toBe("done");
		expect(env.buildOf("add")).toMatchObject({
			requiresReview: true,
			protectedPaths: ["tsconfig.json"],
		});
		expect(env.events("task.protected_change")[0]?.payload).toMatchObject({
			paths: ["tsconfig.json"],
			severity: "review",
		});
	});

	it("blocks unsafe changed paths such as a guard script", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [
				completed(redTest("add")),
				completed({
					writes: { ...greenImpl("add").writes, "scripts/check-layers.mjs": "process.exit(0)\n" },
				}),
			],
		});
		const summary = await run(env);
		expect(summary.tasks[0]).toMatchObject({ outcome: "blocked", reason: "protected_change" });
	});

	it("blocks a builder that reports blocked", async () => {
		const env = await createBuildEnv({ tasks: [task("add")], builder: [blockedByBuilder()] });
		const summary = await run(env);
		expect(summary.tasks[0]).toMatchObject({ outcome: "blocked", reason: "builder_blocked" });
	});
});

const withIntegrationCommit =
	(holder: { env?: BuildEnv; injected?: string }, atCall: number) =>
	(_request: unknown, index: number) => {
		const env = holder.env;
		if (index !== atCall || !env) return;
		writeFileSync(join(env.target, "src", "second.js"), "export const second = () => 99;\n");
		const committed = commitAll(env.git, env.target, "chore: concurrent change");
		if (!committed.ok) throw new Error(committed.error.message);
		holder.injected = committed.value;
	};

describe("integration (G5)", () => {
	it("E14: a conflicting merge blocks the task, resets integration to the pre-merge commit and keeps earlier tasks DONE", async () => {
		const holder: { env?: BuildEnv; injected?: string } = {};
		const env = await createBuildEnv({
			tasks: [task("first"), task("second")],
			builder: [
				completed(redTest("first")),
				completed(greenImpl("first")),
				completed(redTest("second")),
				completed(greenImpl("second")),
			],
			hook: withIntegrationCommit(holder, 3),
			files: { "src/.keep": "" },
		});
		holder.env = env;
		const summary = await run(env);
		expect(summary.tasks.map((t) => [t.key, t.outcome, t.reason])).toEqual([
			["first", "done", null],
			["second", "blocked", "merge_conflict"],
		]);
		expect(env.taskOf("first").state).toBe("DONE");
		expect(env.taskOf("second").state).toBe("BLOCKED");
		expect(env.git.headSha(env.target)).toEqual({ ok: true, value: holder.injected });
		expect(env.git.isClean(env.target)).toEqual({ ok: true, value: true });
		expect(existsSync(join(env.target, ".git", "MERGE_HEAD"))).toBe(false);
		expect(summary.runState).toBe("BUILDING");
		expect(summary.passed).toBe(false);
	});

	it("resets integration and blocks the task when the check after the merge fails", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: happy("add"),
			wrapRunner: (runner) => {
				let calls = 0;
				return {
					...runner,
					runCheck: async (input) => {
						calls += 1;
						const outcome = await runner.runCheck(input);
						return calls === 3 && outcome.ok
							? { ok: true, value: { ...outcome.value, exitCode: 1 } }
							: outcome;
					},
				};
			},
		});
		const summary = await run(env);
		expect(summary.tasks[0]).toMatchObject({
			outcome: "blocked",
			reason: "integration_check_failed",
		});
		expect(env.git.headSha(env.target)).toEqual({ ok: true, value: env.bootstrapSha });
		expect(env.taskOf("add").state).toBe("BLOCKED");
		expect(env.events("task.integrated")).toHaveLength(0);
	});

	it("E07: only a passed check on exactly the integration head makes a task DONE", async () => {
		const env = await createBuildEnv({ tasks: [task("add")], builder: happy("add") });
		await run(env);
		const done = env.events("task.integrated")[0]?.payload;
		const check = env.storage.checks.get(String(done?.checkId));
		if (!check) throw new Error("integration check missing");
		const head = env.git.headSha(env.target);
		if (!head.ok) throw new Error(head.error.message);
		expect(check.commitSha).toBe(head.value);
		const green = env.storage.checks
			.listByRun(env.runId)
			.filter((c) => c.taskId === env.taskIds.add)[1];
		expect(green).toBeDefined();
		expect(green && isCheckEvidenceValid(green, head.value)).toBe(false);
		expect(green?.commitSha).toBe(env.buildOf("add")?.headCommit);
		expect(env.buildOf("add")?.integrationCommit).toBe(head.value);
	});
});

describe("dependencies, limits and resume", () => {
	it("keeps a dependent PENDING behind a BLOCKED task and promotes dependents when a task is DONE", async () => {
		const twoMusts = {
			requirements: [
				{
					id: "REQ-001",
					text: "Do it",
					acceptance: ["Works"],
					priority: "must" as const,
					sourceRef: "PRD",
				},
				{
					id: "REQ-002",
					text: "Also",
					acceptance: ["Works"],
					priority: "must" as const,
					sourceRef: "PRD",
				},
			],
			assumptions: [],
			contradictions: [],
			outOfScope: [],
			openQuestions: [],
		};
		const env = await createBuildEnv({
			spec: twoMusts,
			tasks: [
				task("a"),
				task("b", ["a"]),
				task("c", [], ["REQ-002"]),
				task("d", ["c"], ["REQ-002"]),
			],
			builder: [
				blockedByBuilder(),
				completed(redTest("c")),
				completed(greenImpl("c")),
				completed(redTest("d")),
				completed(greenImpl("d")),
			],
		});
		const summary = await run(env);
		expect(env.taskOf("a").state).toBe("BLOCKED");
		expect(env.taskOf("b").state).toBe("PENDING");
		expect(env.taskOf("c").state).toBe("DONE");
		expect(env.taskOf("d").state).toBe("DONE");
		expect(summary.stoppedBecause).toBe("blocked_tasks");
		expect(summary.blockedTasks).toEqual([{ key: "a", reason: "builder_blocked" }]);
		expect(summary.runState).toBe("BUILDING");
	});

	it("stops cleanly at --max-provider-calls, releases the lease and continues later without redoing the red call", async () => {
		const env = await createBuildEnv({ tasks: [task("add")], builder: happy("add") });
		const first = await run(env, { maxProviderCalls: 1 });
		expect(first.stoppedBecause).toBe("max_provider_calls");
		expect(first.providerCalls).toBe(1);
		expect(first.tasks[0]).toMatchObject({ key: "add", outcome: "released" });
		const released = env.taskOf("add");
		expect(released.state).toBe("READY");
		expect(released.leaseOwner).toBeNull();
		expect(env.buildOf("add")?.phase).toBe("red_observed");
		const second = await run(env);
		expect(second.tasks[0]?.outcome).toBe("done");
		expect(env.builderCalls()).toHaveLength(2);
		expect(env.events("task.red_observed")).toHaveLength(1);
	});

	it("stops after --max-tasks tasks", async () => {
		const env = await createBuildEnv({
			tasks: [task("a"), task("b")],
			builder: [...happy("a"), ...happy("b")],
		});
		const summary = await run(env, { maxTasks: 1 });
		expect(summary.stoppedBecause).toBe("max_tasks");
		expect(env.taskOf("a").state).toBe("DONE");
		expect(env.taskOf("b").state).toBe("READY");
	});

	it("resumes after an interruption between the red commit and the green call", async () => {
		const holder: { crash: boolean } = { crash: true };
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: happy("add"),
			hook: (_request, index) => {
				if (index === 1 && holder.crash) {
					holder.crash = false;
					throw new Error("simulated crash");
				}
			},
		});
		await expect(buildRun(env.deps, { runId: env.runId })).rejects.toThrow("simulated crash");
		expect(env.buildOf("add")?.phase).toBe("red_observed");
		expect(env.taskOf("add").state).not.toBe("READY");
		env.clock.advance(24 * 60 * 60 * 1000);
		const resumed = resumeRun(env.deps, { runId: env.runId });
		expect(resumed.ok && resumed.value.expiredTaskIds).toEqual([env.taskIds.add]);
		const summary = await run(env);
		expect(summary.tasks[0]?.outcome).toBe("done");
		expect(env.events("task.red_observed")).toHaveLength(1);
		const redCalls = env
			.builderCalls()
			.filter((c) => c.systemPrompt.includes("Role: builder, red phase"));
		expect(redCalls).toHaveLength(1);
		expect(env.taskOf("add").state).toBe("DONE");
	});
});

describe("status and repair bound", () => {
	it("lists blocked tasks with their reasons and the tasks that need review", async () => {
		const env = await createBuildEnv({
			tasks: [task("a"), task("b")],
			builder: [
				blockedByBuilder(),
				completed(redTest("b")),
				completed({ writes: { ...greenImpl("b").writes, "biome.json": "{}\n" } }),
			],
		});
		await run(env);
		const status = getRunStatus(env.deps, { runId: env.runId, eventLimit: 5 });
		if (!status.ok) throw new Error(status.error.message);
		expect(status.value.planning.blockedTasks).toEqual([{ key: "a", reason: "builder_blocked" }]);
		expect(status.value.planning.reviewTasks).toEqual(["b"]);
	});

	it("honors repairsPerTask = 0 by blocking after the first failing green check", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [
				completed(redTest("add")),
				completed(greenImpl("add", 2)),
				completed(greenImpl("add", 1)),
			],
		});
		const summary = await run(env, { repairsPerTask: 0 });
		expect(env.builderCalls()).toHaveLength(2);
		expect(summary.tasks[0]).toMatchObject({ outcome: "blocked", reason: "green_not_reached" });
	});
});

describe("H3b hardening: append-only tests, config and red purity", () => {
	it("blocks a task that edits a test written by an earlier task", async () => {
		const env = await createBuildEnv({
			tasks: [task("first"), task("second")],
			builder: [
				completed(redTest("first")),
				completed(greenImpl("first")),
				completed(redTest("second")),
				completed({
					writes: {
						...greenImpl("second").writes,
						"test/first.test.js": "import { test } from 'node:test';\ntest('weak', () => {});\n",
					},
				}),
			],
		});
		const summary = await run(env);
		expect(summary.tasks.map((t) => [t.key, t.outcome, t.reason])).toEqual([
			["first", "done", null],
			["second", "blocked", "protected_change"],
		]);
		expect(env.events("task.protected_change").at(-1)?.payload).toMatchObject({
			paths: ["test/first.test.js"],
			severity: "blocked",
			reasons: { "test/first.test.js": "base_test_modified" },
		});
	});

	it("blocks a task that deletes a test written by an earlier task", async () => {
		const env = await createBuildEnv({
			tasks: [task("first"), task("second")],
			builder: [
				completed(redTest("first")),
				completed(greenImpl("first")),
				completed(redTest("second")),
				completed({ ...greenImpl("second"), deletes: ["test/first.test.js"] }),
			],
		});
		const summary = await run(env);
		expect(summary.tasks[1]).toMatchObject({ outcome: "blocked", reason: "protected_change" });
	});

	it("blocks test runner config changes", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [
				completed(redTest("add")),
				completed({
					writes: { ...greenImpl("add").writes, "vitest.config.ts": "export default {};\n" },
				}),
			],
		});
		const summary = await run(env);
		expect(summary.tasks[0]).toMatchObject({ outcome: "blocked", reason: "protected_change" });
	});

	it("marks .npmrc, dependency and test-helper changes for review but still finishes DONE", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [
				completed(redTest("add")),
				completed({
					writes: {
						...greenImpl("add").writes,
						".npmrc": "registry=https://example.invalid/\n",
						".gitignore": "dist\n",
						"test/helpers/util.js": "export const u = 1;\n",
						"package.json": JSON.stringify({
							name: "p",
							type: "module",
							scripts: { test: "node --test", check: "node --test" },
							dependencies: { left: "1.0.0" },
						}),
					},
				}),
			],
		});
		const summary = await run(env);
		expect(summary.tasks[0]?.outcome).toBe("done");
		const build = env.buildOf("add");
		expect(build?.requiresReview).toBe(true);
		expect([...(build?.protectedPaths ?? [])].sort()).toEqual(
			[".gitignore", ".npmrc", "package.json", "test/helpers/util.js"].sort(),
		);
		expect(env.events("task.integrated")[0]?.payload).toMatchObject({ requiresReview: true });
	});

	it("repairs a red commit that contains source files once, then continues", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [
				completed({
					writes: { ...redTest("add").writes, "src/add.js": "export const add = () => 1;\n" },
				}),
				completed({ deletes: ["src/add.js"] }),
				completed(greenImpl("add")),
			],
		});
		const summary = await run(env);
		expect(summary.tasks[0]?.outcome).toBe("done");
		expect(env.builderCalls()).toHaveLength(3);
	});

	it("blocks with red_not_test_only when the red repair still leaves source files", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [
				completed({
					writes: { ...redTest("add").writes, "src/add.js": "export const add = () => 1;\n" },
				}),
				completed({ writes: { "test/extra.test.js": "x\n" } }),
			],
		});
		const summary = await run(env);
		expect(summary.tasks[0]).toMatchObject({ outcome: "blocked", reason: "red_not_test_only" });
		expect(env.builderCalls()).toHaveLength(2);
	});
});

describe("H3b hardening: crash around the integration merge", () => {
	const crashed = async (deps: Parameters<typeof buildRun>[0], runId: string) => {
		await expect(buildRun(deps, { runId })).rejects.toThrow("simulated crash");
	};

	it("recovers when the process dies after the merge but before the merged phase is saved", async () => {
		const env = await createBuildEnv({ tasks: [task("add")], builder: happy("add") });
		const crashing = {
			...env.deps,
			git: {
				...env.deps.git,
				mergeNoFf: (input: Parameters<typeof env.git.mergeNoFf>[0]) => {
					env.git.mergeNoFf(input);
					throw new Error("simulated crash");
				},
			},
		};
		await crashed(crashing, env.runId);
		expect(env.buildOf("add")).toMatchObject({
			phase: "reviewed",
			preMergeCommit: env.bootstrapSha,
		});
		env.clock.advance(24 * 60 * 60 * 1000);
		resumeRun(env.deps, { runId: env.runId });
		const summary = await run(env);
		expect(summary.tasks[0]?.outcome).toBe("done");
		expect(env.buildOf("add")).toMatchObject({ preMergeCommit: env.bootstrapSha });
		expect(env.git.headSha(env.target)).toEqual({
			ok: true,
			value: env.buildOf("add")?.integrationCommit,
		});
	});

	it("blocks with integration_head_moved when the head moved for another reason before the merge was recorded", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: happy("add"),
			files: { "src/.keep": "" },
		});
		const crashing = {
			...env.deps,
			git: {
				...env.deps.git,
				mergeNoFf: () => {
					throw new Error("simulated crash");
				},
			},
		};
		await crashed(crashing, env.runId);
		writeFileSync(join(env.target, "src", "other.js"), "export const other = 1;\n");
		const committed = commitAll(env.git, env.target, "chore: concurrent change");
		expect(committed.ok).toBe(true);
		env.clock.advance(24 * 60 * 60 * 1000);
		resumeRun(env.deps, { runId: env.runId });
		const summary = await run(env);
		expect(summary.tasks[0]).toMatchObject({
			outcome: "blocked",
			reason: "integration_head_moved",
		});
	});

	it("continues to the check when the process dies after the merged phase was saved", async () => {
		let calls = 0;
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: happy("add"),
			wrapRunner: (runner) => ({
				...runner,
				runCheck: async (input) => {
					calls += 1;
					if (calls === 3) throw new Error("simulated crash");
					return runner.runCheck(input);
				},
			}),
		});
		await crashed(env.deps, env.runId);
		expect(env.buildOf("add")?.phase).toBe("merged");
		env.clock.advance(24 * 60 * 60 * 1000);
		resumeRun(env.deps, { runId: env.runId });
		const summary = await run(env);
		expect(summary.tasks[0]?.outcome).toBe("done");
	});
});
