import { describe, expect, it } from "vitest";
import { RELEASE_POLICY_PATH } from "../src/domain/release/plan.js";
import { buildRunReport } from "../src/modules/delivery/build-report.js";
import { deployRelease, prepareRelease } from "../src/modules/delivery/release.js";
import { buildRun } from "../src/modules/execution/build-run.js";
import { ok } from "../src/shared/result.js";
import {
	type BuildEnv,
	completed,
	createBuildEnv,
	greenImpl,
	redTest,
	task,
} from "./helpers/build-env.js";
import { createFakeDeployment } from "./helpers/fake-deployment.js";

const readyEnv = async (): Promise<BuildEnv> => {
	const env = await createBuildEnv({
		tasks: [task("add")],
		builder: [completed(redTest("add")), completed(greenImpl("add"))],
	});
	const built = await buildRun(env.deps, { runId: env.runId });
	if (!built.ok || built.value.runState !== "READY_FOR_RELEASE") throw new Error("not ready");
	return env;
};

const withReleasePolicy = (env: BuildEnv, enabled: boolean) => ({
	...env.deps,
	factoryFiles: {
		read: (path: string) =>
			path === RELEASE_POLICY_PATH
				? ok({ content: JSON.stringify({ enabled }), sha256: "0".repeat(64) })
				: env.deps.factoryFiles.read(path),
	},
});

const releaseOf = (env: BuildEnv) => {
	const report = buildRunReport(env.deps, env.runId);
	if (!report.ok) throw new Error(report.error.message);
	return report.value.release.status;
};

describe("release preparation", () => {
	it("produces a runbook with build, migrations, smoke and rollback with the expand/contract caveat, and a plan artifact", async () => {
		const env = await readyEnv();
		const prepared = prepareRelease(env.deps, { runId: env.runId });
		if (!prepared.ok) throw new Error(prepared.error.message);
		const { plan, runbook } = prepared.value;
		expect(plan).toMatchObject({
			runId: env.runId,
			publishingEnabled: false,
			runbookPath: "docs/operations/release.md",
			commit: expect.stringMatching(/^[0-9a-f]{40}$/),
		});
		for (const section of [
			"Artefacto inmutable",
			"Migraciones",
			"Checks de humo",
			"Rollback",
			"expand/contract",
		]) {
			expect(runbook).toContain(section);
		}
		expect(runbook).toContain("DESACTIVADA");
		expect(env.storage.artifacts.latest(env.runId, "release-plan", "plan")?.path).toBe(
			prepared.value.planArtifactPath,
		);
		const again = prepareRelease(env.deps, { runId: env.runId });
		expect(again.ok && again.value.planArtifactPath).toBe(prepared.value.planArtifactPath);
		expect(
			env.storage.artifacts.list(env.runId).filter((a) => a.kind === "release-plan"),
		).toHaveLength(2);
	});
});

describe("release state machine (E20)", () => {
	it("refuses to deploy while release.enabled is false (the default) and touches nothing", async () => {
		const env = await readyEnv();
		env.storage.runs.setDeliveryTarget(env.runId, "production");
		const port = createFakeDeployment({ smokeHealthy: true });
		const result = await deployRelease(env.deps, { runId: env.runId, port });
		expect(result).toMatchObject({ ok: false, error: { code: "release_disabled" } });
		expect(port.calls).toEqual([]);
		expect(env.storage.runs.get(env.runId)?.state).toBe("READY_FOR_RELEASE");
	});

	it("marks the release healthy and the run SUCCEEDED only after a passing smoke check", async () => {
		const env = await readyEnv();
		env.storage.runs.setDeliveryTarget(env.runId, "production");
		const port = createFakeDeployment({ smokeHealthy: true });
		const result = await deployRelease(withReleasePolicy(env, true), { runId: env.runId, port });
		if (!result.ok) throw new Error(result.error.message);
		expect(result.value).toMatchObject({ status: "HEALTHY", rollback: null });
		expect(port.calls).toEqual([expect.stringMatching(/^deploy [0-9a-f]{40}$/), "smoke"]);
		expect(env.storage.runs.get(env.runId)?.state).toBe("SUCCEEDED");
		expect(releaseOf(env)).toBe("HEALTHY");
	});

	it("records FAILED_SMOKE, executes the rollback step and never reports a healthy release or a succeeded run", async () => {
		const env = await readyEnv();
		env.storage.runs.setDeliveryTarget(env.runId, "production");
		const port = createFakeDeployment({ smokeHealthy: false });
		const result = await deployRelease(withReleasePolicy(env, true), { runId: env.runId, port });
		if (!result.ok) throw new Error(result.error.message);
		expect(result.value.status).toBe("FAILED_SMOKE");
		expect(result.value.rollback?.steps.join("\n")).toContain("expand/contract");
		expect(port.calls.at(-1)).toBe("rollback");
		expect(env.storage.runs.get(env.runId)?.state).toBe("BLOCKED");
		expect(env.events("release.healthy")).toHaveLength(0);
		expect(env.events("release.smoke_failed")[0]?.payload).toMatchObject({
			detail: "GET /health/ready -> 503",
		});
		expect(env.events("release.rollback_recorded")[0]?.payload).toMatchObject({
			executed: true,
			runbook: "docs/operations/release.md",
		});
		expect(releaseOf(env)).toBe("FAILED_SMOKE");
		const block = env.events("run.state_changed").findLast((e) => e.payload.to === "BLOCKED");
		expect(String(block?.payload.nextStep)).toContain("Rollback recorded");
	});

	it("requires delivery=production and a ready run", async () => {
		const env = await readyEnv();
		const port = createFakeDeployment({ smokeHealthy: true });
		expect(
			await deployRelease(withReleasePolicy(env, true), { runId: env.runId, port }),
		).toMatchObject({
			ok: false,
			error: { code: "delivery_not_production" },
		});
		expect(port.calls).toEqual([]);
	});
});
