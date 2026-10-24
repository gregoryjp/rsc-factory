import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRun } from "../src/modules/execution/build-run.js";
import { resumeRun } from "../src/modules/runs/resume-run.js";
import {
	type BuildEnv,
	completed,
	createBuildEnv,
	greenImpl,
	redTest,
	task,
} from "./helpers/build-env.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const gitOut = (cwd: string, args: string[]) =>
	spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { PATH: process.env.PATH ?? "" },
	}).stdout.trim();

const run = async (env: BuildEnv) => {
	const result = await buildRun(env.deps, { runId: env.runId });
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.value;
};

const happy = (key: string) => [completed(redTest(key)), completed(greenImpl(key))];

const phaseCalls = (env: BuildEnv, phase: string) =>
	env.builderCalls().filter((c) => c.systemPrompt.includes(`Role: builder, ${phase} `));

describe("E08 crash recovery", () => {
	it("(a) a crash during the builder edit leaves a dirty worktree; resume discards it and creates no duplicate commits", async () => {
		const holder = { crash: true };
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: happy("add"),
			hook: (request, index) => {
				if (index === 1 && holder.crash) {
					holder.crash = false;
					writeFileSync(join(request.cwd, "src-stale.js"), "partial edit\n");
					writeFileSync(join(request.cwd, "package.json"), "{ half written");
					throw new Error("simulated crash");
				}
			},
		});
		await expect(buildRun(env.deps, { runId: env.runId })).rejects.toThrow("simulated crash");
		expect(env.buildOf("add")?.phase).toBe("red_observed");

		env.clock.advance(DAY_MS);
		const resumed = resumeRun(env.deps, { runId: env.runId });
		expect(resumed.ok && resumed.value.expiredTaskIds).toEqual([env.taskIds.add]);

		const summary = await run(env);
		expect(summary.tasks[0]?.outcome).toBe("done");
		expect(phaseCalls(env, "red")).toHaveLength(1);
		expect(phaseCalls(env, "green")).toHaveLength(1);
		const subjects = gitOut(env.target, [
			"log",
			"--format=%s",
			"--no-merges",
			"factory/integration",
		]).split("\n");
		expect(subjects.filter((s) => s.startsWith("test(add)"))).toHaveLength(1);
		expect(subjects.filter((s) => s.startsWith("feat(add)"))).toHaveLength(1);
		expect(
			gitOut(env.target, ["ls-tree", "-r", "--name-only", "factory/integration"]),
		).not.toContain("src-stale.js");
		expect(gitOut(env.target, ["show", "factory/integration:package.json"])).toContain('"name"');
	});

	it("(a2) a commit made right before the crash but never recorded is discarded, not duplicated", async () => {
		const holder = { crash: true };
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [
				completed(redTest("add")),
				completed(greenImpl("add")),
				completed(greenImpl("add")),
			],
			hook: (request, index) => {
				if (index === 1 && holder.crash) {
					holder.crash = false;
					const git = (args: string[]) =>
						spawnSync("git", args, { cwd: request.cwd, env: { PATH: process.env.PATH ?? "" } });
					writeFileSync(join(request.cwd, "orphan.txt"), "orphan\n");
					git(["add", "orphan.txt"]);
					git(["-c", "user.name=x", "-c", "user.email=x@y", "commit", "-m", "orphan commit"]);
					throw new Error("simulated crash");
				}
			},
		});
		await expect(buildRun(env.deps, { runId: env.runId })).rejects.toThrow("simulated crash");
		env.clock.advance(DAY_MS);
		resumeRun(env.deps, { runId: env.runId });
		const summary = await run(env);
		expect(summary.tasks[0]?.outcome).toBe("done");
		expect(gitOut(env.target, ["log", "--format=%s", "factory/integration"])).not.toContain(
			"orphan commit",
		);
	});

	it("(b) a crash after the red commit and before recording the red check re-runs the check on the same commit with no new builder call", async () => {
		const holder = { crash: true };
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: happy("add"),
			wrapRunner: (runner) => ({
				...runner,
				runCheck: async (input) => {
					if (holder.crash) {
						holder.crash = false;
						throw new Error("simulated crash during the red check");
					}
					return runner.runCheck(input);
				},
			}),
		});
		await expect(buildRun(env.deps, { runId: env.runId })).rejects.toThrow("red check");
		const stuck = env.buildOf("add");
		expect(stuck?.phase).toBe("red_committed");
		const redCommit = stuck?.redCommit;
		expect(env.storage.checks.listByRun(env.runId)).toHaveLength(0);

		env.clock.advance(DAY_MS);
		resumeRun(env.deps, { runId: env.runId });
		const summary = await run(env);
		expect(summary.tasks[0]?.outcome).toBe("done");
		expect(phaseCalls(env, "red")).toHaveLength(1);
		const redChecks = env.storage.checks
			.listByRun(env.runId)
			.filter((c) => c.cwd === "worktree-red");
		expect(redChecks).toHaveLength(1);
		expect(redChecks[0]?.commitSha).toBe(redCommit);
	});

	it("(c) a failing DB write while recording a check rolls the whole record back and resume ends consistent", async () => {
		const holder = { crash: true };
		const env = await createBuildEnv({ tasks: [task("add")], builder: happy("add") });
		const realAppend = env.storage.events.append;
		env.storage.events.append = (input) => {
			if (holder.crash && input.type === "check.recorded") {
				holder.crash = false;
				throw new Error("simulated DB failure after the check row was inserted");
			}
			return realAppend(input);
		};
		await expect(buildRun(env.deps, { runId: env.runId })).rejects.toThrow("simulated DB failure");
		expect(env.storage.checks.listByRun(env.runId)).toHaveLength(0);
		expect(env.events("check.recorded")).toHaveLength(0);
		expect(env.buildOf("add")?.phase).toBe("red_committed");

		env.clock.advance(DAY_MS);
		resumeRun(env.deps, { runId: env.runId });
		const summary = await run(env);
		expect(summary.tasks[0]?.outcome).toBe("done");
		const checks = env.storage.checks.listByRun(env.runId);
		expect(env.events("check.recorded")).toHaveLength(checks.length);
		expect(new Set(checks.map((c) => c.id)).size).toBe(checks.length);
		expect(phaseCalls(env, "red")).toHaveLength(1);
	});

	it("(e) a reservation made by a process that died before charging is charged as unknown on resume and logged", async () => {
		const holder = { crash: true };
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
		const open = env.storage.budgets.openReservations(env.runId);
		expect(open).toHaveLength(1);
		expect(open[0]).toMatchObject({ role: "builder", amountUsd: 3 });

		resumeRun(env.deps, { runId: env.runId });
		expect(env.storage.budgets.openReservations(env.runId)).toHaveLength(1);

		env.clock.advance(DAY_MS);
		resumeRun(env.deps, { runId: env.runId });
		expect(env.storage.budgets.openReservations(env.runId)).toHaveLength(0);
		expect(env.storage.budgets.summary(env.runId)).toMatchObject({
			chargedUnknownUsd: 3,
			reservedUsd: 0,
		});
		const logged = env.events("budget.reservation_expired");
		expect(logged).toHaveLength(1);
		expect(logged[0]?.payload).toMatchObject({
			role: "builder",
			amountUsd: 3,
			basis: "unknown_reservation",
		});
		expect(existsSync(env.target)).toBe(true);
	});
});
