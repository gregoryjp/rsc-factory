import { DEFAULT_REPAIRS_PER_TASK } from "../../config/env.js";
import type { Check } from "../../contracts/entities.js";
import type { RunState } from "../../contracts/states.js";
import { isCheckEvidenceValid, isCheckPassed } from "../../domain/checks/evidence.js";
import { type Failure, fail, ok, type Result } from "../../shared/result.js";
import { reconcileStaleReservations, STALE_RESERVATION_MS } from "../budget/reconcile.js";
import type { PlanDeps } from "../planning/deps.js";
import { blockRun, gateBlockedRun } from "../runs/block-run.js";
import { transitionRun } from "../runs/transition-run.js";
import { claimTask } from "../tasks/lease-task.js";
import {
	type BootstrapDeps,
	type BootstrapSummary,
	bootstrapProduct,
} from "./bootstrap-product.js";
import { loadCheckPolicy } from "./build-policy.js";
import {
	CHECK_TIMEOUT_MS,
	completedFinalCheck,
	INSTALL_TIMEOUT_MS,
	stepsFor,
} from "./check-steps.js";
import { type CheckDeps, runAndRecordChecks } from "./record-check.js";
import { DEFAULT_REVIEW_DIFF_MAX_BYTES } from "./review-task.js";
import type { StopInfo } from "./stop.js";
import {
	INTEGRATION_BRANCH,
	LEASE_TTL_MS,
	processTask,
	type TaskContext,
	type TaskReport,
} from "./task-build.js";

export type BuildDeps = BootstrapDeps & CheckDeps;

export type BootstrapBuildSummary = {
	bootstrap: BootstrapSummary;
	checks: Check[];
	passed: boolean;
};

const PRODUCT_CHECKS: ReadonlyArray<{ argv: readonly string[]; timeoutMs: number }> = [
	{ argv: ["npm", "ci"], timeoutMs: INSTALL_TIMEOUT_MS },
	{ argv: ["npm", "run", "check"], timeoutMs: CHECK_TIMEOUT_MS },
];

export const buildBootstrapOnly = async (
	deps: BuildDeps,
	input: { runId: string },
): Promise<Result<BootstrapBuildSummary, Failure<string>>> => {
	const outcome = await (async (): Promise<Result<BootstrapBuildSummary, Failure<string>>> => {
		const bootstrap = bootstrapProduct(deps, input);
		if (!bootstrap.ok) return bootstrap;
		const run = deps.storage.runs.get(input.runId);
		const targetPath = run?.targetPath;
		if (!run || targetPath === null || targetPath === undefined) {
			return fail("target_missing", `Run ${input.runId} has no target path`);
		}
		const valid = deps.targets.revalidate(targetPath);
		if (!valid.ok) return valid;
		const ran = await runAndRecordChecks(deps, {
			runId: input.runId,
			taskId: null,
			repoDir: targetPath,
			cwdLabel: "product",
			steps: PRODUCT_CHECKS.map((step) => ({ ...step, env: {} })),
		});
		if (!ran.ok) return ran;
		const checks = ran.value;
		const passed =
			checks.length === PRODUCT_CHECKS.length && checks.every((check) => isCheckPassed(check));
		return ok({ bootstrap: bootstrap.value, checks, passed });
	})();
	const torn = await deps.runner.teardown(input.runId);
	if (!torn.ok && outcome.ok) return torn;
	return outcome;
};

export const DEFAULT_MAX_PROVIDER_CALLS = 40;
const CANCEL_POLL_MS = 500;

export type BuildRunDeps = BuildDeps & PlanDeps;

export type BuildOptions = {
	runId: string;
	maxTasks?: number;
	maxProviderCalls?: number;
	repairsPerTask?: number;
	reviewDiffMaxBytes?: number;
	force?: boolean;
	cancelPollMs?: number;
};

export type BuildStop =
	| "run_complete"
	| "blocked_tasks"
	| "no_ready_tasks"
	| "max_tasks"
	| "max_provider_calls"
	| "provider_unavailable"
	| "budget_exhausted"
	| "quota_wait"
	| "run_canceled"
	| "final_check_failed";

export type BuildSummary = {
	runId: string;
	bootstrap: BootstrapSummary | null;
	tasks: TaskReport[];
	providerCalls: number;
	stoppedBecause: BuildStop;
	stopDetail: string | null;
	runState: RunState;
	blockedTasks: { key: string; reason: string }[];
	reviewTasks: string[];
	finalCheck: Check | null;
	passed: boolean;
};

type BuildFailure = Failure<string>;

const REVIEW_STEPS = [
	"VERIFYING",
	"REVIEWING",
	"INTEGRATING",
] as const satisfies readonly RunState[];

const advanceTo = (
	deps: BuildRunDeps,
	runId: string,
	states: readonly RunState[],
	reason: string,
): Result<void, BuildFailure> => {
	for (const to of states) {
		const moved = transitionRun(deps, { runId, to, reason });
		if (!moved.ok) return moved;
	}
	return ok(undefined);
};

const blockedTasksOf = (deps: BuildRunDeps, runId: string): { key: string; reason: string }[] =>
	deps.storage.tasks.listByRun(runId).flatMap((task) => {
		if (task.state !== "BLOCKED") return [];
		const meta = deps.storage.taskMeta.getByTask(task.id);
		const reason = deps.storage.taskBuilds.get(task.id)?.blockedReason ?? meta?.blockedReason;
		return [{ key: meta?.key ?? task.id, reason: reason ?? "unknown" }];
	});

const reviewTasksOf = (deps: BuildRunDeps, runId: string): string[] =>
	deps.storage.taskBuilds
		.listByRun(runId)
		.filter((build) => build.requiresReview)
		.map((build) => deps.storage.taskMeta.getByTask(build.taskId)?.key ?? build.taskId);

const prepareRun = (
	deps: BuildRunDeps,
	runId: string,
	force: boolean,
): Result<
	{ bootstrap: BootstrapSummary | null; target: string; bootstrapSha: string },
	BuildFailure
> => {
	const run = deps.storage.runs.get(runId);
	if (!run) return fail("run_not_found", `Run ${runId} not found`);
	if (run.targetPath === null) return fail("target_missing", `Run ${runId} has no target path`);
	const target = run.targetPath;
	reconcileStaleReservations(deps, {
		runId,
		staleAfterMs: STALE_RESERVATION_MS,
		now: deps.clock.now(),
	});
	if (run.state === "BLOCKED") {
		const gated = gateBlockedRun(deps, { runId, force });
		if (!gated.ok) return gated;
	}
	const current = deps.storage.runs.get(runId) ?? run;
	let bootstrap: BootstrapSummary | null = null;
	if (current.state === "PLANNING") {
		const booted = bootstrapProduct(deps, { runId });
		if (!booted.ok) return booted;
		bootstrap = booted.value;
		const moved = transitionRun(deps, { runId, to: "BUILDING" });
		if (!moved.ok) return moved;
	} else if (current.state !== "BUILDING") {
		return fail(
			"run_not_buildable",
			`Run ${runId} is ${current.state}; build needs PLANNING or BUILDING`,
		);
	}
	const valid = deps.targets.revalidate(target);
	if (!valid.ok) return valid;
	const booted = deps.storage.events
		.list(runId, {})
		.filter((event) => event.type === "product.bootstrapped")
		.at(-1);
	const bootstrapSha = booted?.payload.commitSha;
	if (typeof bootstrapSha !== "string") {
		return fail("bootstrap_missing", `Run ${runId} has no bootstrapped product`);
	}
	const clean = deps.git.isClean(target);
	if (!clean.ok) return clean;
	if (!clean.value) {
		return fail(
			"target_dirty",
			"The product repository has uncommitted changes; refusing to build",
		);
	}
	const branch = deps.git.checkoutBranch({
		repoDir: target,
		branch: INTEGRATION_BRANCH,
		createFromSha: bootstrapSha,
	});
	if (!branch.ok) return branch;
	return ok({ bootstrap, target, bootstrapSha });
};

const blockForHalt = (
	deps: BuildRunDeps,
	runId: string,
	reason: "budget_exhausted" | "quota_wait",
	detail: string | null,
	info: StopInfo,
): Result<void, BuildFailure> => {
	const nextStep =
		reason === "quota_wait"
			? `Wait until the provider quota resets${info.waitUntil == null ? "" : ` (${new Date(info.waitUntil).toISOString()})`}, then run \`factory build ${runId}\` again (or pass --force).`
			: `Run \`factory budget ${runId} --add <usd>\` (the next call needs ${info.needUsd ?? "?"} USD, ${info.remainingUsd ?? "?"} USD remain), then run \`factory build ${runId}\` again.`;
	return blockRun(deps, {
		runId,
		cause: reason,
		reason: detail ?? reason,
		nextStep,
		...(reason === "quota_wait" ? { waitUntil: info.waitUntil ?? null } : {}),
		...(info.needUsd === undefined ? {} : { needUsd: info.needUsd }),
		...(info.remainingUsd === undefined ? {} : { remainingUsd: info.remainingUsd }),
	});
};

const recordCancelEffects = (deps: BuildRunDeps, runId: string, owner: string): void => {
	const builds = deps.storage.taskBuilds.listByRun(runId);
	const effects = builds.map((build) => ({
		task: deps.storage.taskMeta.getByTask(build.taskId)?.key ?? build.taskId,
		phase: build.phase,
		redCommit: build.redCommit,
		headCommit: build.headCommit,
		integrationCommit: build.integrationCommit,
	}));
	deps.storage.events.append({
		runId,
		type: "build.canceled",
		payload: {
			owner,
			commitsMade: effects.filter((e) => e.redCommit !== null || e.headCommit !== null).length,
			mergesDone: effects.filter((e) => e.integrationCommit !== null).length,
			effects,
		},
		now: deps.clock.now(),
	});
};

const finalizeRun = async (
	deps: BuildRunDeps,
	ctx: TaskContext,
): Promise<Result<{ check: Check | null; passed: boolean }, BuildFailure>> => {
	const advanced = advanceTo(
		deps,
		ctx.runId,
		REVIEW_STEPS,
		"all tasks DONE; verification and review stages arrive in H4",
	);
	if (!advanced.ok) return advanced;
	const steps = stepsFor(ctx.policy, "check");
	const ran = await runAndRecordChecks(deps, {
		runId: ctx.runId,
		taskId: null,
		repoDir: ctx.target,
		cwdLabel: "integration-final",
		steps,
	});
	if (!ran.ok) return ran;
	const check = completedFinalCheck(ran.value, steps.length);
	const head = deps.git.headSha(ctx.target);
	if (!head.ok) return head;
	const passed =
		check !== undefined && isCheckPassed(check) && isCheckEvidenceValid(check, head.value);
	const moved = transitionRun(deps, {
		runId: ctx.runId,
		to: passed ? "READY_FOR_RELEASE" : "BLOCKED",
		reason: passed ? "final integration check passed" : "final_check_failed",
	});
	if (!moved.ok) return moved;
	return ok({ check: ran.value.at(-1) ?? null, passed });
};

export const buildRun = async (
	deps: BuildRunDeps,
	options: BuildOptions,
): Promise<Result<BuildSummary, BuildFailure>> => {
	const outcome = await (async (): Promise<Result<BuildSummary, BuildFailure>> => {
		const prepared = prepareRun(deps, options.runId, options.force === true);
		if (!prepared.ok) return prepared;
		const policy = loadCheckPolicy(deps, options.runId);
		if (!policy.ok) return policy;
		const controller = new AbortController();
		const live: BuildRunDeps = { ...deps, signal: controller.signal };
		const watcher = setInterval(() => {
			if (deps.storage.runs.get(options.runId)?.state === "CANCELED") controller.abort();
		}, options.cancelPollMs ?? CANCEL_POLL_MS);
		watcher.unref();
		try {
			return await driveBuild(live, options, prepared.value, policy.value);
		} finally {
			clearInterval(watcher);
		}
	})();
	const torn = await deps.runner.teardown(options.runId);
	if (!torn.ok && outcome.ok) return torn;
	return outcome;
};

const driveBuild = async (
	deps: BuildRunDeps,
	options: BuildOptions,
	prepared: { bootstrap: BootstrapSummary | null; target: string },
	policy: TaskContext["policy"],
): Promise<Result<BuildSummary, BuildFailure>> => {
	{
		const ctx: TaskContext = {
			deps,
			runId: options.runId,
			target: prepared.target,
			policy,
			owner: deps.ids("owner"),
			repairsPerTask: options.repairsPerTask ?? DEFAULT_REPAIRS_PER_TASK,
			reviewDiffMaxBytes: options.reviewDiffMaxBytes ?? DEFAULT_REVIEW_DIFF_MAX_BYTES,
			budget: { used: 0, max: options.maxProviderCalls ?? DEFAULT_MAX_PROVIDER_CALLS },
		};
		const reports: TaskReport[] = [];
		const attempted = new Set<string>();
		let stop: { reason: BuildStop; detail: string | null } | undefined;
		let haltInfo: StopInfo = {};
		while (stop === undefined) {
			if (options.maxTasks !== undefined && reports.length >= options.maxTasks) {
				stop = { reason: "max_tasks", detail: null };
				break;
			}
			const next = deps.storage.tasks
				.listByRun(options.runId)
				.find((task) => task.state === "READY" && !attempted.has(task.id));
			if (!next) break;
			attempted.add(next.id);
			const key = deps.storage.taskMeta.getByTask(next.id)?.key;
			if (key === undefined)
				return fail("task_meta_missing", `Task ${next.id} has no plan metadata`);
			const claimed = claimTask(deps, { taskId: next.id, owner: ctx.owner, ttlMs: LEASE_TTL_MS });
			if (!claimed.ok) continue;
			const result = await processTask(ctx, { task: claimed.value, key });
			reports.push(result.report);
			if (result.stop) {
				stop = { reason: result.stop.reason, detail: result.stop.detail ?? null };
				haltInfo = result.stop.info ?? {};
			}
		}
		if (stop?.reason === "budget_exhausted" || stop?.reason === "quota_wait") {
			const blocked = blockForHalt(deps, options.runId, stop.reason, stop.detail, haltInfo);
			if (!blocked.ok) return blocked;
		}
		if (stop?.reason === "run_canceled") recordCancelEffects(deps, options.runId, ctx.owner);
		const remaining = deps.storage.tasks.countByState(options.runId);
		const allDone = Object.entries(remaining).every(([state, n]) => state === "DONE" || n === 0);
		let finalCheck: Check | null = null;
		let finalPassed = true;
		if (allDone && stop?.reason !== "run_canceled") {
			const finalized = await finalizeRun(deps, ctx);
			if (!finalized.ok) return finalized;
			finalCheck = finalized.value.check;
			finalPassed = finalized.value.passed;
		}
		const blockedTasks = blockedTasksOf(deps, options.runId);
		const reason: BuildStop = !finalPassed
			? "final_check_failed"
			: stop !== undefined && !allDone
				? stop.reason
				: allDone
					? "run_complete"
					: blockedTasks.length > 0
						? "blocked_tasks"
						: "no_ready_tasks";
		const run = deps.storage.runs.get(options.runId);
		return ok({
			runId: options.runId,
			bootstrap: prepared.bootstrap,
			tasks: reports,
			providerCalls: ctx.budget.used,
			stoppedBecause: reason,
			stopDetail: stop?.detail ?? null,
			runState: run?.state ?? "BUILDING",
			blockedTasks,
			reviewTasks: reviewTasksOf(deps, options.runId),
			finalCheck,
			passed: allDone && finalPassed,
		});
	}
};
