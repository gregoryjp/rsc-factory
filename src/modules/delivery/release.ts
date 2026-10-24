import type { ReleasePlan, ReleasePolicy } from "../../domain/release/plan.js";
import {
	DEFAULT_RELEASE_POLICY,
	RELEASE_POLICY_PATH,
	ReleasePolicySchema,
	ROLLBACK_STEPS,
	RUNBOOK_PATH,
	renderReleaseRunbook,
} from "../../domain/release/plan.js";
import { type Failure, fail, ok, type Result } from "../../shared/result.js";
import type { AppDeps } from "../deps.js";
import { loadCheckPolicy } from "../execution/build-policy.js";
import type { PlanDeps } from "../planning/deps.js";
import { transitionRun } from "../runs/transition-run.js";
import { buildRunReport } from "./build-report.js";
import type { DeploymentPort } from "./ports.js";
import { recordVersioned } from "./record-versioned.js";

export type ReleaseDeps = AppDeps & Pick<PlanDeps, "artifactStore" | "factoryFiles" | "settings">;

const reportDepsOf = (deps: ReleaseDeps) => ({
	storage: deps.storage,
	factoryHome: deps.settings.factoryHome,
});

export const loadReleasePolicy = (
	deps: Pick<PlanDeps, "factoryFiles">,
): Result<ReleasePolicy, Failure<string>> => {
	const read = deps.factoryFiles.read(RELEASE_POLICY_PATH);
	if (!read.ok) return ok(DEFAULT_RELEASE_POLICY);
	try {
		const parsed = ReleasePolicySchema.safeParse(JSON.parse(read.value.content));
		return parsed.success
			? ok(parsed.data)
			: fail("release_policy_invalid", `${RELEASE_POLICY_PATH}: ${parsed.error.message}`);
	} catch {
		return fail("release_policy_invalid", `${RELEASE_POLICY_PATH} is not valid JSON`);
	}
};

export type PreparedRelease = {
	plan: ReleasePlan;
	runbook: string;
	runbookPath: string;
	planArtifactPath: string;
};

export const prepareRelease = (
	deps: ReleaseDeps,
	input: { runId: string; commit?: string },
): Result<PreparedRelease, Failure<string>> => {
	const run = deps.storage.runs.get(input.runId);
	if (!run) return fail("run_not_found", `Run ${input.runId} not found`);
	const policy = loadReleasePolicy(deps);
	if (!policy.ok) return policy;
	const checks = loadCheckPolicy(deps, input.runId);
	if (!checks.ok) return checks;
	const report = buildRunReport(reportDepsOf(deps), input.runId);
	if (!report.ok) return report;
	const api = checks.value.preview?.api;
	const plan: ReleasePlan = {
		schemaVersion: 1,
		runId: input.runId,
		projectName: report.value.projectName,
		templateId: checks.value.templateId,
		commit: input.commit ?? report.value.integration.head,
		runbookPath: RUNBOOK_PATH,
		publishingEnabled: policy.value.enabled,
		build: {
			install: checks.value.install,
			check: checks.value.check,
			build: checks.value.preview?.build ?? null,
		},
		migrations: { migrate: api?.migrate ?? null },
		smoke: { healthPath: api?.healthPath ?? null },
		rollback: [...ROLLBACK_STEPS],
	};
	const runbook = renderReleaseRunbook(plan);
	const planned = recordVersioned(
		deps,
		input.runId,
		"release-plan",
		"plan",
		(version) => `release/release-plan-v${version}.json`,
		`${JSON.stringify(plan, null, 2)}\n`,
	);
	if (!planned.ok) return planned;
	const runbookRecorded = recordVersioned(
		deps,
		input.runId,
		"release-plan",
		"runbook",
		(version) => `release/release-v${version}.md`,
		runbook,
	);
	if (!runbookRecorded.ok) return runbookRecorded;
	return ok({ plan, runbook, runbookPath: RUNBOOK_PATH, planArtifactPath: planned.value });
};

export type ReleaseOutcome = {
	runId: string;
	status: "HEALTHY" | "FAILED_SMOKE";
	deploymentId: string;
	smokeDetail: string;
	rollback: { steps: string[]; detail: string } | null;
};

const appendRelease = (
	deps: ReleaseDeps,
	runId: string,
	type:
		| "release.started"
		| "release.deployed"
		| "release.smoke_passed"
		| "release.smoke_failed"
		| "release.rollback_recorded"
		| "release.healthy",
	payload: Record<string, unknown>,
): void => {
	deps.storage.events.append({ runId, type, payload, now: deps.clock.now() });
};

export const deployRelease = async (
	deps: ReleaseDeps,
	input: { runId: string; port: DeploymentPort },
): Promise<Result<ReleaseOutcome, Failure<string>>> => {
	const run = deps.storage.runs.get(input.runId);
	if (!run) return fail("run_not_found", `Run ${input.runId} not found`);
	const policy = loadReleasePolicy(deps);
	if (!policy.ok) return policy;
	if (!policy.value.enabled) {
		return fail(
			"release_disabled",
			"Production release is disabled (factory/policies/release.json enabled=false); nothing was deployed",
		);
	}
	if (run.deliveryTarget !== "production") {
		return fail(
			"delivery_not_production",
			`Run ${run.id} declares delivery ${run.deliveryTarget ?? "undeclared"}, not production`,
		);
	}
	if (run.state !== "READY_FOR_RELEASE") {
		return fail("run_not_ready", `Run ${run.id} is ${run.state}; release needs READY_FOR_RELEASE`);
	}
	const prepared = prepareRelease(deps, { runId: run.id });
	if (!prepared.ok) return prepared;
	const { plan } = prepared.value;
	const report = buildRunReport(reportDepsOf(deps), run.id);
	if (!report.ok) return report;
	if (!report.value.integration.finalCheckValid || plan.commit === null) {
		return fail(
			"final_check_missing",
			"A passed final check on the integration commit is required before releasing",
		);
	}
	const moved = transitionRun(deps, { runId: run.id, to: "RELEASING", reason: "release started" });
	if (!moved.ok) return moved;
	appendRelease(deps, run.id, "release.started", { commit: plan.commit });
	const blockWith = (cause: string, message: string) => {
		transitionRun(deps, {
			runId: run.id,
			to: "BLOCKED",
			reason: cause,
			details: { cause, nextStep: message },
		});
		return fail(cause, message);
	};
	const deployed = await input.port.deploy({ runId: run.id, commit: plan.commit, plan });
	if (!deployed.ok) {
		return blockWith(
			"release_deploy_failed",
			`Deployment failed: ${deployed.error.message}. Follow the rollback section of ${plan.runbookPath}.`,
		);
	}
	const deploymentId = deployed.value.deploymentId;
	appendRelease(deps, run.id, "release.deployed", { deploymentId });
	const smoke = await input.port.smoke({ runId: run.id, deploymentId, plan });
	const healthy = smoke.ok && smoke.value.healthy;
	const smokeDetail = smoke.ok ? smoke.value.detail : smoke.error.message;
	if (healthy) {
		appendRelease(deps, run.id, "release.smoke_passed", { deploymentId, detail: smokeDetail });
		appendRelease(deps, run.id, "release.healthy", { deploymentId });
		const done = transitionRun(deps, { runId: run.id, to: "SUCCEEDED", reason: "release healthy" });
		if (!done.ok) return done;
		return ok({ runId: run.id, status: "HEALTHY", deploymentId, smokeDetail, rollback: null });
	}
	appendRelease(deps, run.id, "release.smoke_failed", { deploymentId, detail: smokeDetail });
	const rolledBack = await input.port.rollback({ runId: run.id, deploymentId, plan });
	const rollbackDetail = rolledBack.ok
		? rolledBack.value.detail
		: `rollback failed: ${rolledBack.error.message}`;
	appendRelease(deps, run.id, "release.rollback_recorded", {
		deploymentId,
		steps: plan.rollback,
		runbook: plan.runbookPath,
		detail: rollbackDetail,
		executed: rolledBack.ok,
	});
	const blocked = transitionRun(deps, {
		runId: run.id,
		to: "BLOCKED",
		reason: "release_smoke_failed",
		details: {
			cause: "release_smoke_failed",
			nextStep: `Smoke failed: ${smokeDetail}. Rollback recorded; follow ${plan.runbookPath} (section 4) and fix before releasing again.`,
		},
	});
	if (!blocked.ok) return blocked;
	return ok({
		runId: run.id,
		status: "FAILED_SMOKE",
		deploymentId,
		smokeDetail,
		rollback: { steps: plan.rollback, detail: rollbackDetail },
	});
};
