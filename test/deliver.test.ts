import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deliverRun } from "../src/modules/delivery/deliver-run.js";
import { buildRun } from "../src/modules/execution/build-run.js";
import type { CheckRunnerPort } from "../src/modules/execution/ports.js";
import { commitGuarded } from "../src/modules/execution/safe-commit.js";
import { getRunStatus } from "../src/modules/runs/get-run-status.js";
import { ok } from "../src/shared/result.js";
import {
	type BuildEnv,
	completed,
	createBuildEnv,
	greenImpl,
	redTest,
	task,
} from "./helpers/build-env.js";

const gitOut = (cwd: string, ...args: string[]) =>
	spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { PATH: process.env.PATH ?? "" },
	}).stdout.trim();

type Control = { calls: number; failFrom: number | null; failCount: number };

const flaky =
	(control: Control) =>
	(runner: CheckRunnerPort): CheckRunnerPort => ({
		...runner,
		runCheck: async (input) => {
			const result = await runner.runCheck(input);
			if (!result.ok || control.failFrom === null) return result;
			control.calls += 1;
			const failing =
				control.calls >= control.failFrom && control.calls < control.failFrom + control.failCount;
			return ok(failing ? { ...result.value, exitCode: 1 } : result.value);
		},
	});

const finishedRun = async (control?: Control): Promise<BuildEnv> => {
	const env = await createBuildEnv({
		tasks: [task("add")],
		builder: [completed(redTest("add")), completed(greenImpl("add"))],
		...(control ? { wrapRunner: flaky(control) } : {}),
	});
	const built = await buildRun(env.deps, { runId: env.runId });
	if (!built.ok || built.value.runState !== "READY_FOR_RELEASE") {
		throw new Error(
			`build did not finish: ${built.ok ? built.value.runState : built.error.message}`,
		);
	}
	return env;
};

const deliver = (env: BuildEnv) => deliverRun(env.deps, { runId: env.runId });

const runState = (env: BuildEnv) => env.storage.runs.get(env.runId)?.state;
const branch = (env: BuildEnv) => gitOut(env.target, "rev-parse", "--abbrev-ref", "HEAD");
const labelled = (env: BuildEnv, label: string) =>
	env.storage.checks.listByRun(env.runId).filter((check) => check.cwd === label);

describe("deliver", () => {
	it("writes the report on integration, merges into main and binds the final check to the main merge commit", async () => {
		const env = await finishedRun();
		const integrationBefore = gitOut(env.target, "rev-parse", "factory/integration");
		const mainBefore = gitOut(env.target, "rev-parse", "main");
		const delivered = await deliver(env);
		if (!delivered.ok) throw new Error(`${delivered.error.code}: ${delivered.error.message}`);
		const summary = delivered.value;
		expect(summary.alreadyDelivered).toBe(false);
		expect(runState(env)).toBe("SUCCEEDED");
		expect(env.storage.runs.get(env.runId)?.deliveryTarget).toBe("local");

		const mainHead = gitOut(env.target, "rev-parse", "main");
		expect(summary.mainCommit).toBe(mainHead);
		expect(
			gitOut(env.target, "rev-list", "--parents", "-n", "1", "main").split(" ").slice(1),
		).toEqual([mainBefore, gitOut(env.target, "rev-parse", "factory/integration")]);
		const subjects = gitOut(env.target, "log", "main", "--format=%s");
		expect(subjects).toContain(`docs(verification): factory report for ${env.runId}`);
		expect(subjects).toContain("merge(add)");
		const reportCommit = gitOut(env.target, "rev-parse", "factory/integration");
		expect(summary.reportCommit).toBe(reportCommit);
		expect(gitOut(env.target, "rev-parse", `${reportCommit}^`)).not.toBe(
			integrationBefore === reportCommit ? "" : "x",
		);
		expect(
			gitOut(env.target, "diff", "--name-only", integrationBefore, reportCommit).split("\n").sort(),
		).toEqual([
			"docs/operations/release.md",
			"docs/verification/factory-report.json",
			"docs/verification/factory-report.md",
		]);

		const json = JSON.parse(
			gitOut(env.target, "show", "main:docs/verification/factory-report.json"),
		);
		expect(json).toMatchObject({
			schemaVersion: 1,
			runId: env.runId,
			delivery: { status: "in_progress" },
			provider: { mode: "fake" },
		});
		expect(json.requirements.map((r: { status: string }) => r.status)).toEqual(["entregado"]);
		expect(gitOut(env.target, "show", "main:docs/verification/factory-report.md")).toContain(
			env.runId,
		);
		expect(gitOut(env.target, "show", "main:docs/operations/release.md")).toContain("Rollback");

		const [reportCheck] = labelled(env, "delivery-report");
		const [mainCheck] = labelled(env, "delivery-main");
		expect(reportCheck).toMatchObject({ exitCode: 0, commitSha: reportCommit });
		expect(mainCheck).toMatchObject({ exitCode: 0, commitSha: mainHead });
		expect(env.events("delivery.completed")[0]?.payload).toMatchObject({
			mainCommit: mainHead,
			reportCommit,
			checkId: mainCheck?.id,
		});
		expect(env.storage.artifacts.list(env.runId).map((a) => a.kind)).toEqual(
			expect.arrayContaining(["report", "release-plan"]),
		);

		expect(branch(env)).toBe("main");
		expect(gitOut(env.target, "status", "--porcelain")).toBe("");
		const status = getRunStatus(env.deps, { runId: env.runId, eventLimit: 1 });
		expect(status.ok && status.value.nextStep).toContain("Finished");
	});

	it("is idempotent: delivering a delivered run changes nothing", async () => {
		const env = await finishedRun();
		await deliver(env);
		const head = gitOut(env.target, "rev-parse", "main");
		const checks = env.storage.checks.listByRun(env.runId).length;
		const again = await deliver(env);
		if (!again.ok) throw new Error(again.error.message);
		expect(again.value).toMatchObject({ alreadyDelivered: true, mainCommit: head });
		expect(gitOut(env.target, "rev-parse", "main")).toBe(head);
		expect(env.storage.checks.listByRun(env.runId)).toHaveLength(checks);
		expect(runState(env)).toBe("SUCCEEDED");
		expect(branch(env)).toBe("main");
	});

	it("never succeeds when the final check on the main merge commit fails, keeps the run READY_FOR_RELEASE and resumes without duplicating the report", async () => {
		const control: Control = { calls: 0, failFrom: null, failCount: 1 };
		const env = await finishedRun(control);
		const mainBefore = gitOut(env.target, "rev-parse", "main");
		control.failFrom = 2;
		const failed = await deliver(env);
		expect(failed).toMatchObject({ ok: false, error: { code: "delivery_main_check_failed" } });
		expect(runState(env)).toBe("READY_FOR_RELEASE");
		expect(gitOut(env.target, "rev-parse", "main")).toBe(mainBefore);
		expect(branch(env)).toBe("main");
		expect(gitOut(env.target, "status", "--porcelain")).toBe("");
		expect(env.events("delivery.failed")[0]?.payload).toMatchObject({
			cause: "delivery_main_check_failed",
		});
		expect(env.events("delivery.completed")).toHaveLength(0);
		const status = getRunStatus(env.deps, { runId: env.runId, eventLimit: 1 });
		expect(status.ok && status.value.nextStep).toContain("factory deliver");

		control.failFrom = null;
		const resumed = await deliver(env);
		if (!resumed.ok) throw new Error(`${resumed.error.code}: ${resumed.error.message}`);
		expect(runState(env)).toBe("SUCCEEDED");
		const reportCommits = gitOut(env.target, "log", "main", "--format=%s")
			.split("\n")
			.filter((s) => s.startsWith("docs(verification)"));
		expect(reportCommits).toHaveLength(1);
		expect(labelled(env, "delivery-main").map((c) => c.exitCode)).toEqual([1, 0]);
		expect(labelled(env, "delivery-main").at(-1)?.commitSha).toBe(
			gitOut(env.target, "rev-parse", "main"),
		);
	});

	it("drops the report commit when its own check fails, leaving integration and main untouched", async () => {
		const control: Control = { calls: 0, failFrom: null, failCount: 1 };
		const env = await finishedRun(control);
		const integration = gitOut(env.target, "rev-parse", "factory/integration");
		const main = gitOut(env.target, "rev-parse", "main");
		control.failFrom = 1;
		const failed = await deliver(env);
		expect(failed).toMatchObject({ ok: false, error: { code: "delivery_report_check_failed" } });
		expect(gitOut(env.target, "rev-parse", "factory/integration")).toBe(integration);
		expect(gitOut(env.target, "rev-parse", "main")).toBe(main);
		expect(runState(env)).toBe("READY_FOR_RELEASE");
		expect(branch(env)).toBe("main");
		control.failFrom = null;
		const retried = await deliver(env);
		expect(retried.ok).toBe(true);
		expect(runState(env)).toBe("SUCCEEDED");
	});

	it("refuses a run that is not ready and a head without final-check evidence", async () => {
		const notReady = await createBuildEnv({ tasks: [task("add")], builder: [] });
		expect(await deliver(notReady)).toMatchObject({ ok: false, error: { code: "run_not_ready" } });

		const env = await finishedRun();
		writeFileSync(join(env.target, "stray.txt"), "x\n");
		const stray = commitGuarded(env.git, env.target, "chore: stray commit without a check");
		expect(stray.ok).toBe(true);
		const refused = await deliver(env);
		expect(refused).toMatchObject({ ok: false, error: { code: "final_check_missing" } });
		expect(runState(env)).toBe("READY_FOR_RELEASE");
		expect(gitOut(env.target, "rev-parse", "main")).toBe(env.bootstrapSha);
	});

	it("refuses delivery=production because release publishing is disabled", async () => {
		const env = await finishedRun();
		env.storage.runs.setDeliveryTarget(env.runId, "production");
		expect(await deliver(env)).toMatchObject({
			ok: false,
			error: { code: "delivery_production_unsupported" },
		});
		expect(runState(env)).toBe("READY_FOR_RELEASE");
	});
});
