import { isCheckEvidenceValid, isCheckPassed } from "../../domain/checks/evidence.js";
import { RUNBOOK_PATH } from "../../domain/release/plan.js";
import { renderReportJson, renderReportMarkdown } from "../../domain/report/render.js";
import { type Failure, fail, ok, type Result } from "../../shared/result.js";
import { loadCheckPolicy } from "../execution/build-policy.js";
import type { BuildRunDeps } from "../execution/build-run.js";
import { assertDoneEvidence, completedFinalCheck, stepsFor } from "../execution/check-steps.js";
import { runAndRecordChecks } from "../execution/record-check.js";
import { commitGuarded } from "../execution/safe-commit.js";
import { INTEGRATION_BRANCH } from "../execution/task-build.js";
import { transitionRun } from "../runs/transition-run.js";
import { buildRunReport, DELIVERY_CHECK_PREFIX, FINAL_CHECK_CWD } from "./build-report.js";
import { recordVersioned } from "./record-versioned.js";
import { prepareRelease } from "./release.js";

export const MAIN_BRANCH = "main";
export const REPORT_MD_PATH = "docs/verification/factory-report.md";
export const REPORT_JSON_PATH = "docs/verification/factory-report.json";
export const REPORT_CHECK_CWD = `${DELIVERY_CHECK_PREFIX}report`;
export const MAIN_CHECK_CWD = `${DELIVERY_CHECK_PREFIX}main`;

export type DeliverDeps = BuildRunDeps;

export type DeliverySummary = {
	runId: string;
	alreadyDelivered: boolean;
	targetPath: string;
	reportCommit: string;
	mainCommit: string;
	reportPath: string;
	reportJsonPath: string;
	runbookPath: string;
	remotes: string[];
};

type DeliverFailure = Failure<string>;

const FINAL_LABELS: readonly string[] = [FINAL_CHECK_CWD];

const reportMessage = (runId: string): string => `docs(verification): factory report for ${runId}`;

const summaryOf = (
	deps: DeliverDeps,
	runId: string,
	targetPath: string,
	commits: { reportCommit: string; mainCommit: string },
	alreadyDelivered: boolean,
): DeliverySummary => {
	const remotes = deps.git.remoteNames(targetPath);
	return {
		runId,
		alreadyDelivered,
		targetPath,
		...commits,
		reportPath: REPORT_MD_PATH,
		reportJsonPath: REPORT_JSON_PATH,
		runbookPath: RUNBOOK_PATH,
		remotes: remotes.ok ? remotes.value : [],
	};
};

const recordFailure = (
	deps: DeliverDeps,
	runId: string,
	failure: DeliverFailure,
): DeliverFailure => {
	deps.storage.events.append({
		runId,
		type: "delivery.failed",
		payload: { cause: failure.code, message: failure.message },
		now: deps.clock.now(),
	});
	return failure;
};

const passedOn = (
	deps: DeliverDeps,
	runId: string,
	labels: readonly string[],
	commit: string,
	argv: readonly string[],
): boolean =>
	deps.storage.checks
		.listByRun(runId)
		.some(
			(check) =>
				labels.includes(check.cwd) &&
				check.taskId === null &&
				assertDoneEvidence(check, { head: commit, taskId: null, argv }).ok,
		);

type Locked = {
	targetPath: string;
	policyArgv: readonly string[];
	steps: ReturnType<typeof stepsFor>;
};

const writeReport = (
	deps: DeliverDeps,
	runId: string,
	targetPath: string,
): Result<void, DeliverFailure> => {
	const report = buildRunReport(deps, runId, { preDelivery: true });
	if (!report.ok) return report;
	const markdown = renderReportMarkdown(report.value);
	const json = renderReportJson(report.value);
	const prepared = prepareRelease(deps, { runId });
	if (!prepared.ok) return prepared;
	const artifacts = [
		recordVersioned(
			deps,
			runId,
			"report",
			"markdown",
			(v) => `report/factory-report-v${v}.md`,
			markdown,
		),
		recordVersioned(deps, runId, "report", "json", (v) => `report/factory-report-v${v}.json`, json),
	];
	const failedArtifact = artifacts.find((a) => !a.ok);
	if (failedArtifact && !failedArtifact.ok) return failedArtifact;
	const files: [string, string][] = [
		[REPORT_MD_PATH, markdown],
		[REPORT_JSON_PATH, json],
		[RUNBOOK_PATH, prepared.value.runbook],
	];
	for (const [path, content] of files) {
		const written = deps.writer.writeFile(targetPath, path, Buffer.from(content, "utf8"));
		if (!written.ok) return written;
	}
	return ok(undefined);
};

const commitReport = (
	deps: DeliverDeps,
	runId: string,
	locked: Locked,
): Result<{ head: string; base: string }, DeliverFailure> => {
	const base = deps.git.headSha(locked.targetPath);
	if (!base.ok) return base;
	const evidence = passedOn(deps, runId, FINAL_LABELS, base.value, locked.policyArgv);
	if (!evidence) {
		return fail(
			"final_check_missing",
			`No passed final check is recorded for the integration head ${base.value}; run \`factory build ${runId}\` first`,
		);
	}
	deps.storage.events.append({
		runId,
		type: "delivery.started",
		payload: { integrationHead: base.value },
		now: deps.clock.now(),
	});
	const written = writeReport(deps, runId, locked.targetPath);
	if (!written.ok) return written;
	const committed = commitGuarded(deps.git, locked.targetPath, reportMessage(runId));
	if (!committed.ok) return fail(committed.error.code, committed.error.message);
	deps.storage.events.append({
		runId,
		type: "delivery.report_committed",
		payload: { commit: committed.value, base: base.value },
		now: deps.clock.now(),
	});
	return ok({ head: committed.value, base: base.value });
};

const checkOn = async (
	deps: DeliverDeps,
	runId: string,
	locked: Locked,
	label: string,
	commit: string,
): Promise<Result<boolean, DeliverFailure>> => {
	if (passedOn(deps, runId, [label], commit, locked.policyArgv)) return ok(true);
	const ran = await runAndRecordChecks(deps, {
		runId,
		taskId: null,
		repoDir: locked.targetPath,
		cwdLabel: label,
		steps: locked.steps,
	});
	if (!ran.ok) return ran;
	const check = completedFinalCheck(ran.value, locked.steps.length);
	return ok(check !== undefined && isCheckPassed(check) && isCheckEvidenceValid(check, commit));
};

const deliverLocked = async (
	deps: DeliverDeps,
	runId: string,
	locked: Locked,
): Promise<Result<DeliverySummary, DeliverFailure>> => {
	const { git, storage } = deps;
	const target = locked.targetPath;
	const clean = git.isClean(target);
	if (!clean.ok) return clean;
	if (!clean.value)
		return fail(
			"target_dirty",
			"The product repository has uncommitted changes; refusing to deliver",
		);
	const onIntegration = git.checkoutBranch({ repoDir: target, branch: INTEGRATION_BRANCH });
	if (!onIntegration.ok) return onIntegration;
	const head0 = git.headSha(target);
	if (!head0.ok) return head0;
	const marker = storage.events
		.list(runId, {})
		.findLast((e) => e.type === "delivery.report_committed");
	const resumed = marker !== undefined && marker.payload.commit === head0.value;
	let reportHead = head0.value;
	let base = typeof marker?.payload.base === "string" ? marker.payload.base : head0.value;
	if (!resumed) {
		const committed = commitReport(deps, runId, locked);
		if (!committed.ok) return committed;
		reportHead = committed.value.head;
		base = committed.value.base;
	}
	const reportOk = await checkOn(deps, runId, locked, REPORT_CHECK_CWD, reportHead);
	if (!reportOk.ok) return reportOk;
	if (!reportOk.value) {
		const reset = git.resetBranch({
			repoDir: target,
			runId,
			branch: INTEGRATION_BRANCH,
			to: base,
			holdsLock: true,
		});
		if (!reset.ok) return reset;
		return fail(
			"delivery_report_check_failed",
			`The full check failed on the report commit ${reportHead}; integration was restored to ${base}`,
		);
	}
	const onMain = git.checkoutBranch({ repoDir: target, branch: MAIN_BRANCH });
	if (!onMain.ok) return onMain;
	const mainHead = git.headSha(target);
	if (!mainHead.ok) return mainHead;
	const parents = git.parentsOf(target, mainHead.value);
	if (!parents.ok) return parents;
	const alreadyMerged = parents.value.includes(reportHead);
	const mainBefore = alreadyMerged ? (parents.value[0] ?? mainHead.value) : mainHead.value;
	let mainCommit = mainHead.value;
	if (!alreadyMerged) {
		const merged = git.mergeNoFf({
			repoDir: target,
			runId,
			into: MAIN_BRANCH,
			from: INTEGRATION_BRANCH,
			message: `merge(factory): deliver ${runId}`,
			holdsLock: true,
		});
		if (!merged.ok) {
			return fail(
				merged.error.code === "merge_conflict" ? "delivery_merge_conflict" : merged.error.code,
				merged.error.message,
			);
		}
		mainCommit = merged.value;
	}
	const mainOk = await checkOn(deps, runId, locked, MAIN_CHECK_CWD, mainCommit);
	if (!mainOk.ok) return mainOk;
	if (!mainOk.value) {
		const reset = git.resetBranch({
			repoDir: target,
			runId,
			branch: MAIN_BRANCH,
			to: mainBefore,
			holdsLock: true,
		});
		if (!reset.ok) return reset;
		return fail(
			"delivery_main_check_failed",
			`The full check failed on the main merge commit ${mainCommit}; main was restored to ${mainBefore} and the run is not delivered`,
		);
	}
	const mainCheck = storage.checks
		.listByRun(runId)
		.findLast((c) => c.cwd === MAIN_CHECK_CWD && c.commitSha === mainCommit && c.exitCode === 0);
	storage.events.append({
		runId,
		type: "delivery.completed",
		payload: {
			mainCommit,
			reportCommit: reportHead,
			checkId: mainCheck?.id ?? null,
			target: "local",
		},
		now: deps.clock.now(),
	});
	const done = transitionRun(deps, { runId, to: "SUCCEEDED", reason: "delivered locally on main" });
	if (!done.ok) return done;
	return ok(summaryOf(deps, runId, target, { reportCommit: reportHead, mainCommit }, false));
};

export const deliverRun = async (
	deps: DeliverDeps,
	input: { runId: string },
): Promise<Result<DeliverySummary, DeliverFailure>> => {
	const { storage } = deps;
	const run = storage.runs.get(input.runId);
	if (!run) return fail("run_not_found", `Run ${input.runId} not found`);
	const completed = storage.events
		.list(run.id, {})
		.findLast((e) => e.type === "delivery.completed");
	if (run.state === "SUCCEEDED" && completed !== undefined && run.targetPath !== null) {
		return ok(
			summaryOf(
				deps,
				run.id,
				run.targetPath,
				{
					reportCommit: String(completed.payload.reportCommit ?? ""),
					mainCommit: String(completed.payload.mainCommit ?? ""),
				},
				true,
			),
		);
	}
	if (run.state !== "READY_FOR_RELEASE") {
		return fail(
			"run_not_ready",
			`Run ${run.id} is ${run.state}; deliver needs READY_FOR_RELEASE (run \`factory build ${run.id}\`)`,
		);
	}
	if (run.deliveryTarget === "production") {
		return fail(
			"delivery_production_unsupported",
			"delivery=production is not supported: production publishing is disabled by policy (release.enabled=false)",
		);
	}
	if (run.targetPath === null) return fail("target_missing", `Run ${run.id} has no target path`);
	const valid = deps.targets.revalidate(run.targetPath);
	if (!valid.ok) return valid;
	const policy = loadCheckPolicy(deps, run.id);
	if (!policy.ok) return policy;
	const steps = stepsFor(policy.value, "check");
	const last = steps.at(-1);
	if (!last) return fail("check_policy_invalid", "The check policy has no check command");
	if (run.deliveryTarget === null) {
		storage.runs.setDeliveryTarget(run.id, "local");
		storage.events.append({
			runId: run.id,
			type: "delivery.declared",
			payload: { target: "local" },
			now: deps.clock.now(),
		});
	}
	const locked: Locked = { targetPath: run.targetPath, policyArgv: last.argv, steps };
	const outcome = await deps.git.withMergeLock<DeliverySummary, DeliverFailure>(run.id, () =>
		deliverLocked(deps, run.id, locked),
	);
	const restored = deps.git.checkoutBranch({ repoDir: run.targetPath, branch: MAIN_BRANCH });
	const torn = await deps.runner.teardown(run.id);
	if (!outcome.ok) {
		recordFailure(deps, run.id, outcome.error);
		return outcome;
	}
	if (!restored.ok) return restored;
	if (!torn.ok) return torn;
	return outcome;
};
