import { describe, expect, it } from "vitest";
import { renderReportMarkdown } from "../src/domain/report/render.js";
import { buildRunReport } from "../src/modules/delivery/build-report.js";
import { deliverRun } from "../src/modules/delivery/deliver-run.js";
import { buildRun } from "../src/modules/execution/build-run.js";
import { RETRYABLE_REASONS } from "../src/modules/execution/retry-task.js";
import { getRunStatus } from "../src/modules/runs/get-run-status.js";
import { completed, createBuildEnv, greenImpl, redTest, task } from "./helpers/build-env.js";
import {
	BASELINE_HIGH_SAST,
	BROKEN_SAST,
	CLEAN_SAST,
	MEDIUM_SAST,
	NEW_HIGH_SAST,
	SAST_SCRIPT,
	sastRunner,
} from "./helpers/sast.js";

type Step = { stdout: string; exitCode: number };
const out = (stdout: string, exitCode = 0): Step => ({ stdout, exitCode });

const setup = async (steps: Step[], over: { sast?: string | undefined } = {}) => {
	const runner = sastRunner((i) => steps[Math.min(i, steps.length - 1)] ?? out(CLEAN_SAST));
	const sast = "sast" in over ? over.sast : SAST_SCRIPT;
	const env = await createBuildEnv({
		tasks: [task("add")],
		builder: [completed(redTest("add")), completed(greenImpl("add"))],
		wrapRunner: runner.wrap,
		...(sast ? { sast } : {}),
	});
	const result = await buildRun(env.deps, { runId: env.runId });
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
	return { env, runner, summary: result.value };
};

const recorded = (env: Awaited<ReturnType<typeof setup>>["env"]) =>
	env.events("sast.recorded").map((e) => e.payload);

describe("SAST gate", () => {
	it("records a baseline, scans the task and the integration, and passes a clean product", async () => {
		const { env, runner, summary } = await setup([out(CLEAN_SAST)]);
		expect(summary.tasks[0]?.outcome).toBe("done");
		expect(env.storage.runs.get(env.runId)?.state).toBe("READY_FOR_RELEASE");
		expect(runner.calls).toHaveLength(3);
		expect(recorded(env).map((p) => [p.phase, p.status])).toEqual([
			["baseline", "baseline"],
			["task", "pass"],
			["integration", "pass"],
		]);
		expect(env.storage.artifacts.latest(env.runId, "sast-baseline", env.runId)).toBeDefined();
		const scans = env.storage.checks
			.listByRun(env.runId)
			.filter((c) => c.argv[1] === "--input-type=module");
		expect(scans).toHaveLength(3);
		expect(scans[1]?.commitSha).toMatch(/^[0-9a-f]{40}$/);
	});

	it("lists baseline findings as accepted_baseline and does not block on them", async () => {
		const { env, summary } = await setup([out(BASELINE_HIGH_SAST)]);
		expect(summary.tasks[0]?.outcome).toBe("done");
		expect(recorded(env)[1]).toMatchObject({ status: "pass", newSevere: [] });
		expect(JSON.stringify(recorded(env)[1]?.acceptedBaseline)).toContain("eval-call");
	});

	it("blocks the task with sast_new_finding on a new high finding, retryable", async () => {
		const { env, summary } = await setup([out(BASELINE_HIGH_SAST), out(NEW_HIGH_SAST)]);
		expect(summary.tasks[0]).toMatchObject({ outcome: "blocked", reason: "sast_new_finding" });
		expect(RETRYABLE_REASONS).toContain("sast_new_finding");
		expect(env.events("task.integrated")).toHaveLength(0);
		expect(JSON.stringify(recorded(env)[1]?.newSevere)).toContain("react-raw-html");
	});

	it("does not block on medium findings", async () => {
		const { summary } = await setup([out(CLEAN_SAST), out(MEDIUM_SAST)]);
		expect(summary.tasks[0]?.outcome).toBe("done");
	});

	it("blocks the run at the integration scan on a new high finding", async () => {
		const { env, summary } = await setup([out(CLEAN_SAST), out(CLEAN_SAST), out(NEW_HIGH_SAST)]);
		expect(summary.tasks[0]?.outcome).toBe("done");
		expect(env.storage.runs.get(env.runId)?.state).toBe("BLOCKED");
		expect(recorded(env).at(-1)).toMatchObject({ phase: "integration", status: "new_finding" });
	});

	it.each([
		["a crash exit", out("boom", 1)],
		["output without a result line", out(BROKEN_SAST)],
	])("treats %s as unavailable: a warning per task, never a pass", async (_name, bad) => {
		const { env, summary } = await setup([out(CLEAN_SAST), bad]);
		expect(summary.tasks[0]?.outcome).toBe("done");
		expect(env.events("sast.warning")).toHaveLength(1);
		expect(recorded(env).map((p) => p.status)).toEqual(["baseline", "unavailable", "unavailable"]);
	});

	it("shows the scan in report and status", async () => {
		const { env } = await setup([out(BASELINE_HIGH_SAST), out(MEDIUM_SAST), out(BROKEN_SAST)]);
		const report = buildRunReport(env.deps, env.runId);
		if (!report.ok) throw new Error(report.error.message);
		expect(report.value.sastScan.unavailable).toBe(true);
		const markdown = renderReportMarkdown(report.value);
		expect(markdown).toContain("## Análisis estático (SAST)");
		expect(markdown).toContain("accepted_baseline");
		const status = getRunStatus(env.deps, { runId: env.runId, eventLimit: 5 });
		if (!status.ok) throw new Error(status.error.message);
		expect(status.value.sastScan.entries.map((e) => e.status)).toEqual([
			"baseline",
			"pass",
			"unavailable",
		]);
	});

	it("blocks delivery with sast_unavailable and delivers once the scanner works again", async () => {
		const state = { down: false };
		const runner = sastRunner(() => (state.down ? out(BROKEN_SAST) : out(CLEAN_SAST)));
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [completed(redTest("add")), completed(greenImpl("add"))],
			wrapRunner: runner.wrap,
			sast: SAST_SCRIPT,
		});
		const built = await buildRun(env.deps, { runId: env.runId });
		expect(built.ok && built.value.runState).toBe("READY_FOR_RELEASE");
		state.down = true;
		const blocked = await deliverRun(env.deps, { runId: env.runId });
		expect(blocked.ok).toBe(false);
		if (!blocked.ok) expect(blocked.error.code).toBe("sast_unavailable");
		expect(env.storage.runs.get(env.runId)?.state).not.toBe("SUCCEEDED");
		state.down = false;
		const delivered = await deliverRun(env.deps, { runId: env.runId });
		expect(delivered.ok).toBe(true);
	});

	it("blocks delivery with sast_new_finding when a new high finding appears", async () => {
		const state = { bad: false };
		const runner = sastRunner(() => (state.bad ? out(NEW_HIGH_SAST) : out(CLEAN_SAST)));
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [completed(redTest("add")), completed(greenImpl("add"))],
			wrapRunner: runner.wrap,
			sast: SAST_SCRIPT,
		});
		await buildRun(env.deps, { runId: env.runId });
		state.bad = true;
		const blocked = await deliverRun(env.deps, { runId: env.runId });
		expect(blocked.ok).toBe(false);
		if (!blocked.ok) expect(blocked.error.code).toBe("sast_new_finding");
	});

	it("skips when the check policy defines no SAST", async () => {
		const none = await setup([out(CLEAN_SAST)], { sast: undefined });
		expect(none.runner.calls).toHaveLength(0);
		expect(none.env.events("sast.recorded")).toHaveLength(0);
	});
});
