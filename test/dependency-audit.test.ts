import { describe, expect, it } from "vitest";
import { renderReportJson, renderReportMarkdown } from "../src/domain/report/render.js";
import { buildRunReport } from "../src/modules/delivery/build-report.js";
import { deliverRun } from "../src/modules/delivery/deliver-run.js";
import { buildRun } from "../src/modules/execution/build-run.js";
import { RETRYABLE_REASONS } from "../src/modules/execution/retry-task.js";
import { getRunStatus } from "../src/modules/runs/get-run-status.js";
import { completed, createBuildEnv, greenImpl, redTest, task } from "./helpers/build-env.js";
import {
	AUDIT_ARGV,
	auditRunner,
	BASELINE_HIGH_AUDIT,
	CLEAN_AUDIT,
	HIGH_AUDIT,
	LOCKFILE_EMPTY,
	LOCKFILE_WITH_DEP,
	MALFORMED_AUDIT,
	MODERATE_AUDIT,
	NETWORK_ERROR_AUDIT,
} from "./helpers/npm-audit.js";

type Step = { stdout: string; exitCode: number };
const out = (stdout: string, exitCode = 0): Step => ({ stdout, exitCode });

const setup = async (
	steps: Step[],
	over: { lockfile?: string; audit?: string[] | undefined } = {},
) => {
	const runner = auditRunner(
		(index) => steps[Math.min(index, steps.length - 1)] ?? out(CLEAN_AUDIT),
	);
	const audit = "audit" in over ? over.audit : AUDIT_ARGV;
	const env = await createBuildEnv({
		tasks: [task("add")],
		builder: [completed(redTest("add")), completed(greenImpl("add"))],
		files: { "package-lock.json": over.lockfile ?? LOCKFILE_WITH_DEP },
		wrapRunner: runner.wrap,
		...(audit ? { audit } : {}),
	});
	const result = await buildRun(env.deps, { runId: env.runId });
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
	return { env, runner, summary: result.value };
};

const recorded = (env: Awaited<ReturnType<typeof setup>>["env"]) =>
	env.events("depaudit.recorded").map((e) => e.payload);

describe("dependency audit gate", () => {
	it("records a baseline, audits the task and the integration, and passes a clean product", async () => {
		const { env, runner, summary } = await setup([out(CLEAN_AUDIT)]);
		expect(summary.tasks[0]?.outcome).toBe("done");
		expect(env.storage.runs.get(env.runId)?.state).toBe("READY_FOR_RELEASE");
		expect(runner.calls).toHaveLength(3);
		expect(recorded(env).map((p) => [p.phase, p.status])).toEqual([
			["baseline", "baseline"],
			["task", "pass"],
			["integration", "pass"],
		]);
		expect(env.storage.artifacts.latest(env.runId, "audit-baseline", env.runId)).toBeDefined();
		const auditChecks = env.storage.checks
			.listByRun(env.runId)
			.filter((c) => c.argv[1] === "audit");
		expect(auditChecks).toHaveLength(3);
		expect(auditChecks[0]?.argv).toEqual(AUDIT_ARGV);
		expect(auditChecks[1]?.commitSha).toMatch(/^[0-9a-f]{40}$/);
	});

	it("lists baseline advisories as accepted_baseline and does not block on them", async () => {
		const { env, summary } = await setup([out(BASELINE_HIGH_AUDIT, 1)]);
		expect(summary.tasks[0]?.outcome).toBe("done");
		const task1 = recorded(env)[1];
		expect(task1).toMatchObject({ status: "pass", newSevere: [] });
		expect(task1?.acceptedBaseline).toEqual([
			{ id: "GHSA-35jh-r3h4-6jhm", package: "lodash", severity: "high" },
		]);
	});

	it("shows counts, new versus baseline and unavailable audits in the report and the status", async () => {
		const { env } = await setup([
			out(BASELINE_HIGH_AUDIT, 1),
			out(MODERATE_AUDIT, 1),
			out(NETWORK_ERROR_AUDIT, 1),
		]);
		const report = buildRunReport(env.deps, env.runId);
		if (!report.ok) throw new Error(report.error.message);
		expect(report.value.dependencyAudit.unavailable).toBe(true);
		const markdown = renderReportMarkdown(report.value);
		expect(markdown).toContain("## Auditoría de dependencias");
		expect(markdown).toContain("accepted_baseline");
		expect(markdown).toContain("no disponible");
		const status = getRunStatus(env.deps, { runId: env.runId, eventLimit: 5 });
		if (!status.ok) throw new Error(status.error.message);
		expect(status.value.dependencyAudit.entries.map((e) => e.status)).toEqual([
			"baseline",
			"pass",
			"unavailable",
		]);
		expect(status.value.dependencyAudit.entries[1]?.counts?.moderate).toBe(1);
		expect(JSON.parse(renderReportJson(report.value)).dependencyAudit.unavailable).toBe(true);
	});

	it("blocks the task with audit_new_vulnerability on a new high advisory, retryable", async () => {
		const { env, summary } = await setup([out(BASELINE_HIGH_AUDIT, 1), out(HIGH_AUDIT, 1)]);
		expect(summary.tasks[0]).toMatchObject({
			outcome: "blocked",
			reason: "audit_new_vulnerability",
		});
		expect(RETRYABLE_REASONS).toContain("audit_new_vulnerability");
		expect(env.events("task.integrated")).toHaveLength(0);
		expect(recorded(env)[1]).toMatchObject({ status: "new_vulnerability" });
		expect(JSON.stringify(recorded(env)[1]?.newSevere)).toContain("minimist");
	});

	it("does not block on moderate-only advisories", async () => {
		const { summary } = await setup([out(CLEAN_AUDIT), out(MODERATE_AUDIT, 1)]);
		expect(summary.tasks[0]?.outcome).toBe("done");
	});

	it("blocks the run at the integration check on a new high advisory", async () => {
		const { env, summary } = await setup([out(CLEAN_AUDIT), out(CLEAN_AUDIT), out(HIGH_AUDIT, 1)]);
		expect(summary.tasks[0]?.outcome).toBe("done");
		expect(env.storage.runs.get(env.runId)?.state).toBe("BLOCKED");
		expect(recorded(env).at(-1)).toMatchObject({
			phase: "integration",
			status: "new_vulnerability",
		});
	});

	it.each([
		["a network error", NETWORK_ERROR_AUDIT],
		["malformed output", MALFORMED_AUDIT],
	])("treats %s as unavailable: a warning per task, never a pass", async (_name, bad) => {
		const { env, summary } = await setup([out(CLEAN_AUDIT), out(bad, 1)]);
		expect(summary.tasks[0]?.outcome).toBe("done");
		expect(env.events("depaudit.warning")).toHaveLength(1);
		const statuses = recorded(env).map((p) => p.status);
		expect(statuses).toEqual(["baseline", "unavailable", "unavailable"]);
		expect(recorded(env).at(-1)?.reason).toBeTruthy();
	});

	it("does not record a baseline from an unavailable audit and reports the missing baseline", async () => {
		const { env, summary } = await setup([out(NETWORK_ERROR_AUDIT, 1), out(CLEAN_AUDIT)]);
		expect(summary.tasks[0]?.outcome).toBe("done");
		expect(env.storage.artifacts.latest(env.runId, "audit-baseline", env.runId)).toBeUndefined();
		expect(String(recorded(env)[0]?.reason)).toContain("baseline");
	});

	it("blocks delivery with audit_unavailable while the registry is unreachable and delivers once it is back", async () => {
		const state = { down: false };
		const runner = auditRunner(() => (state.down ? out(NETWORK_ERROR_AUDIT, 1) : out(CLEAN_AUDIT)));
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [completed(redTest("add")), completed(greenImpl("add"))],
			files: { "package-lock.json": LOCKFILE_WITH_DEP },
			wrapRunner: runner.wrap,
			audit: AUDIT_ARGV,
		});
		const built = await buildRun(env.deps, { runId: env.runId });
		expect(built.ok && built.value.runState).toBe("READY_FOR_RELEASE");
		state.down = true;
		const blocked = await deliverRun(env.deps, { runId: env.runId });
		expect(blocked.ok).toBe(false);
		if (!blocked.ok) expect(blocked.error.code).toBe("audit_unavailable");
		expect(env.storage.runs.get(env.runId)?.state).not.toBe("SUCCEEDED");
		state.down = false;
		const delivered = await deliverRun(env.deps, { runId: env.runId });
		expect(delivered.ok).toBe(true);
		expect(env.storage.runs.get(env.runId)?.state).toBe("SUCCEEDED");
	});

	it("blocks delivery with audit_new_vulnerability when a new high advisory appears", async () => {
		const state = { bad: false };
		const runner = auditRunner(() => (state.bad ? out(HIGH_AUDIT, 1) : out(CLEAN_AUDIT)));
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [completed(redTest("add")), completed(greenImpl("add"))],
			files: { "package-lock.json": LOCKFILE_WITH_DEP },
			wrapRunner: runner.wrap,
			audit: AUDIT_ARGV,
		});
		await buildRun(env.deps, { runId: env.runId });
		state.bad = true;
		const blocked = await deliverRun(env.deps, { runId: env.runId });
		expect(blocked.ok).toBe(false);
		if (!blocked.ok) expect(blocked.error.code).toBe("audit_new_vulnerability");
	});

	it("skips products without locked dependencies and without an audit policy", async () => {
		const empty = await setup([out(CLEAN_AUDIT)], { lockfile: LOCKFILE_EMPTY });
		expect(empty.runner.calls).toHaveLength(0);
		expect(empty.summary.tasks[0]?.outcome).toBe("done");
		const none = await setup([out(CLEAN_AUDIT)], { audit: undefined });
		expect(none.runner.calls).toHaveLength(0);
		expect(none.env.events("depaudit.recorded")).toHaveLength(0);
	});
});
