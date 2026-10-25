import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "../../contracts/entities.js";
import {
	classifyChanges,
	dependenciesDiffer,
	type FileChange,
	isPackageJson,
	isTestFile,
	isTestPath,
	scriptsChangeKind,
} from "../../domain/builder/protected-changes.js";
import type { CheckPolicyEntry } from "../../domain/checks/policy.js";
import { isSafeExpectedPath } from "../../domain/planning/paths.js";
import { redactDiff } from "../../domain/security/redact-diff.js";
import { type Failure, fail, ok, type Result } from "../../shared/result.js";
import { recordArtifacts } from "../planning/artifacts.js";
import { buildContextPack } from "../planning/context-pack.js";
import type { PlanDeps } from "../planning/deps.js";
import { isRunCanceled } from "../runs/cancellation.js";
import { heartbeatTask, releaseTask } from "../tasks/lease-task.js";
import { transitionTask } from "../tasks/transition-task.js";
import { type BuilderKind, type BuilderOutput, callBuilder } from "./builder-call.js";
import {
	type FindingForRepair,
	findingsRepairPrompt,
	greenPrompt,
	greenRepairPrompt,
	redPrompt,
	redRepairPrompt,
	withGuidance,
} from "./builder-prompts.js";
import { assertDoneEvidence, completedFinalCheck, stepsFor } from "./check-steps.js";
import { runDependencyAudit } from "./dependency-audit.js";
import type { BuildPhase, TaskBuild } from "./ports.js";
import { type CheckDeps, runAndRecordChecks } from "./record-check.js";
import { runReviews } from "./review-task.js";
import { commitGuarded } from "./safe-commit.js";
import { runSastGate } from "./sast-gate.js";
import { HALT_BY_ERROR_CODE, type HaltReason, type StopInfo, stopInfoOf } from "./stop.js";

export const INTEGRATION_BRANCH = "factory/integration";
export const LEASE_TTL_MS = 45 * 60 * 1000;
const LOG_TAIL_CHARS = 4000;

export type TaskDeps = CheckDeps & PlanDeps;

export type TaskContext = {
	deps: TaskDeps;
	runId: string;
	target: string;
	policy: CheckPolicyEntry & { templateId: string };
	owner: string;
	repairsPerTask: number;
	reviewDiffMaxBytes: number;
	budget: { used: number; max: number };
};

export type TaskReport = {
	key: string;
	outcome: "done" | "blocked" | "released";
	reason: string | null;
	lastCheckId: string | null;
};

export type StopReason = "max_provider_calls" | "provider_unavailable" | HaltReason;

type Step =
	| { next: BuildPhase; patch?: Partial<TaskBuild> }
	| { blocked: string; detail?: string; patch?: Partial<TaskBuild> }
	| { done: true; patch?: Partial<TaskBuild> }
	| { stop: StopReason; detail?: string; info?: StopInfo };

type TaskRef = { task: Task; key: string };

type Handler = (ctx: TaskContext, ref: TaskRef, build: TaskBuild) => Promise<Step>;

const worktreeOf = (ctx: TaskContext, key: string): string =>
	join(ctx.deps.factoryHome, "runs", ctx.runId, "worktrees", key);

const taskBranch = (ctx: TaskContext, ref: TaskRef): string => {
	const retries = ctx.deps.storage.retries.count(ref.task.id);
	return retries === 0 ? `factory/task/${ref.key}` : `factory/task/${ref.key}-r${retries}`;
};

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const failed = (code: string, message: string): Step => ({ blocked: code, detail: message });

const save = (ctx: TaskContext, build: TaskBuild): TaskBuild => {
	const { storage, clock } = ctx.deps;
	const previous = storage.taskBuilds.get(build.taskId);
	const next = { ...build, updatedAt: clock.now() };
	storage.taskBuilds.upsert(next);
	if (previous?.phase !== next.phase) {
		storage.events.append({
			runId: ctx.runId,
			taskId: build.taskId,
			type: "task.phase_changed",
			payload: { phase: next.phase },
			now: clock.now(),
		});
	}
	return next;
};

const moveTask = (
	ctx: TaskContext,
	taskId: string,
	to: Task["state"],
): Result<Task, Failure<string>> => {
	const fresh = ctx.deps.storage.tasks.get(taskId);
	if (!fresh) return fail("task_not_found", `Task ${taskId} not found`);
	if (fresh.state === to) return ok(fresh);
	return transitionTask(ctx.deps, {
		taskId,
		to,
		owner: ctx.owner,
		expectedVersion: fresh.version,
	});
};

const logTail = (ctx: TaskContext, logPath: string): string => {
	try {
		return readFileSync(join(ctx.deps.factoryHome, logPath), "utf8").slice(-LOG_TAIL_CHARS);
	} catch {
		return "(log unavailable)";
	}
};

const readAfter = (worktree: string, path: string, deleted: boolean): string | null => {
	if (deleted) return null;
	const full = join(worktree, path);
	try {
		return lstatSync(full).isSymbolicLink() ? "{" : readFileSync(full, "utf8");
	} catch {
		return "{";
	}
};

type Applied = { commit: string; patch: Partial<TaskBuild> };

const applyChanges = (
	ctx: TaskContext,
	ref: TaskRef,
	build: TaskBuild,
	input: { message: string; lockedTests: readonly string[] },
): Result<Applied, Failure<string>> => {
	const { git, storage, clock } = ctx.deps;
	const worktree = worktreeOf(ctx, ref.key);
	const entries = git.statusEntries(worktree);
	if (!entries.ok) return fail("git_status_failed", entries.error.message);
	if (entries.value.length === 0) return fail("builder_no_changes", "The builder changed nothing");
	const unsafe = entries.value.filter((entry) => !isSafeExpectedPath(entry.path));
	if (unsafe.length > 0) {
		return fail("unsafe_path", `Unsafe changed paths: ${unsafe.map((e) => e.path).join(", ")}`);
	}
	const tampered = entries.value.filter((entry) => input.lockedTests.includes(entry.path));
	if (tampered.length > 0) {
		return fail(
			"tests_tampered",
			`Red-phase tests changed: ${tampered.map((e) => e.path).join(", ")}`,
		);
	}
	const head = git.headSha(worktree);
	if (!head.ok) return fail("git_head_failed", head.error.message);
	const changes: FileChange[] = [];
	for (const entry of entries.value) {
		let scriptsChanged = false;
		let scriptsAdded = false;
		let depsChanged = false;
		let existsInBase = false;
		if (isPackageJson(entry.path)) {
			const before = git.showFile(worktree, head.value, entry.path);
			if (!before.ok) return fail("git_show_failed", before.error.message);
			const after = readAfter(worktree, entry.path, entry.status === "deleted");
			const kind = scriptsChangeKind(before.value, after);
			scriptsChanged = kind === "protected";
			scriptsAdded = kind === "additive";
			depsChanged = dependenciesDiffer(before.value, after);
		}
		if (isTestFile(entry.path) && entry.status !== "added") {
			const inBase = git.blobOid(worktree, build.baseCommit, entry.path);
			if (!inBase.ok) return fail("git_show_failed", inBase.error.message);
			existsInBase = inBase.value !== null;
		}
		changes.push({
			path: entry.path,
			status: entry.status,
			scriptsChanged,
			scriptsAdded,
			depsChanged,
			existsInBase,
		});
	}
	const classification = classifyChanges(changes);
	const emit = (severity: "blocked" | "review", paths: string[]) =>
		storage.events.append({
			runId: ctx.runId,
			taskId: ref.task.id,
			type: "task.protected_change",
			payload: {
				paths,
				severity,
				reasons: Object.fromEntries(paths.map((path) => [path, classification.reasons[path]])),
			},
			now: clock.now(),
		});
	if (classification.blocked.length > 0) {
		emit("blocked", classification.blocked);
		return fail(
			"protected_change",
			`Protected files changed: ${classification.blocked.join(", ")}`,
		);
	}
	const patch: Partial<TaskBuild> = {};
	if (classification.review.length > 0) {
		emit("review", classification.review);
		patch.requiresReview = true;
		patch.protectedPaths = [...new Set([...build.protectedPaths, ...classification.review])];
	}
	const committed = commitGuarded(git, worktree, input.message);
	if (!committed.ok) return fail(committed.error.code, committed.error.message);
	return ok({ commit: committed.value, patch });
};

const packFor = (ctx: TaskContext, ref: TaskRef): Result<string, Failure<string>> => {
	const built = buildContextPack(ctx.deps, { runId: ctx.runId, taskId: ref.task.id });
	if (!built.ok) return fail("context_pack_failed", built.error.message);
	return ok(JSON.stringify(built.value.pack, null, 1));
};

const builderCall = async (
	ctx: TaskContext,
	ref: TaskRef,
	input: { kind: BuilderKind; repair: boolean; prompt: string },
): Promise<Result<BuilderOutput, Step>> => {
	if (ctx.budget.used >= ctx.budget.max) {
		return { ok: false, error: { stop: "max_provider_calls" } };
	}
	ctx.budget.used += 1;
	const called = await callBuilder(ctx.deps, {
		runId: ctx.runId,
		kind: input.kind,
		repair: input.repair,
		cwd: worktreeOf(ctx, ref.key),
		prompt: input.prompt,
	});
	if (!called.ok) {
		const error = called.error;
		const halt = HALT_BY_ERROR_CODE[error.code];
		if (halt !== undefined) {
			return {
				ok: false,
				error: { stop: halt, detail: error.message, info: stopInfoOf(error) },
			};
		}
		return {
			ok: false,
			error: error.retryable
				? { stop: "provider_unavailable", detail: error.message }
				: failed(
						error.code === "builder_invalid_output" ? error.code : "builder_failed",
						error.message,
					),
		};
	}
	return called.value.status === "blocked"
		? { ok: false, error: failed("builder_blocked", called.value.summary) }
		: ok(called.value);
};

const redTestFiles = (
	ctx: TaskContext,
	ref: TaskRef,
	build: TaskBuild,
	head: string,
): Result<string[], Failure<string>> => {
	const names = ctx.deps.git.diffNames(worktreeOf(ctx, ref.key), build.baseCommit, head);
	if (!names.ok) return fail("git_diff_failed", names.error.message);
	const stray = names.value.filter((name) => !isTestPath(name));
	if (stray.length > 0) {
		return fail("red_not_test_only", `The red commit changes non-test files: ${stray.join(", ")}`);
	}
	const tests = names.value.filter(isTestFile);
	return tests.length > 0
		? ok(names.value)
		: fail("red_no_tests", "The red commit contains no test files");
};

const asStep = (error: Failure<string>): Step => failed(error.code, error.message);

const operatorNote = (ctx: TaskContext, ref: TaskRef): string | null =>
	ctx.deps.storage.retries.latestNote(ref.task.id);

const redCommit = async (
	ctx: TaskContext,
	ref: TaskRef,
	build: TaskBuild,
	prompt: string,
	repair: boolean,
): Promise<Step> => {
	const called = await builderCall(ctx, ref, { kind: "red", repair, prompt });
	if (!called.ok) return called.error;
	const applied = applyChanges(ctx, ref, build, {
		message: repair
			? `test(${ref.key}): strengthen failing tests`
			: `test(${ref.key}): add failing tests`,
		lockedTests: [],
	});
	if (!applied.ok) return asStep(applied.error);
	const tests = redTestFiles(ctx, ref, build, applied.value.commit);
	if (!tests.ok && tests.error.code === "red_not_test_only" && !repair) {
		const repaired = await redCommit(
			ctx,
			ref,
			{ ...build, redRepairs: 1 },
			redRepairPrompt(
				prompt,
				`${tests.error.message}. Remove them: the red commit may only contain tests.`,
			),
			true,
		);
		return "next" in repaired
			? { ...repaired, patch: { ...repaired.patch, redRepairs: 1 } }
			: repaired;
	}
	if (!tests.ok) return asStep(tests.error);
	return {
		next: "red_committed",
		patch: {
			...applied.value.patch,
			redCommit: applied.value.commit,
			headCommit: applied.value.commit,
			testFiles: tests.value,
		},
	};
};

const redPromptOf = (ctx: TaskContext, ref: TaskRef): Result<string, Failure<string>> => {
	const pack = packFor(ctx, ref);
	return pack.ok
		? ok(
				withGuidance(
					redPrompt(
						{ key: ref.key, title: ref.task.title, acceptance: ref.task.acceptance },
						pack.value,
					),
					operatorNote(ctx, ref),
				),
			)
		: pack;
};

const startedHandler: Handler = async (ctx, ref, build) => {
	const worktree = worktreeOf(ctx, ref.key);
	if (!existsSync(worktree)) {
		const added = ctx.deps.git.worktreeAdd({
			repoDir: ctx.target,
			runId: ctx.runId,
			taskKey: ref.key,
			branch: taskBranch(ctx, ref),
			baseSha: build.baseCommit,
		});
		if (!added.ok) return failed("worktree_failed", added.error.message);
	}
	const prompt = redPromptOf(ctx, ref);
	if (!prompt.ok) return asStep(prompt.error);
	return redCommit(ctx, ref, build, prompt.value, false);
};

const runPolicyChecks = async (
	ctx: TaskContext,
	ref: TaskRef,
	repoDir: string,
	cwdLabel: string,
	command: "test" | "check",
) => {
	const steps = stepsFor(ctx.policy, command);
	const ran = await runAndRecordChecks(ctx.deps, {
		runId: ctx.runId,
		taskId: ref.task.id,
		repoDir,
		cwdLabel,
		steps,
	});
	if (!ran.ok) return ran;
	return ok({ checks: ran.value, final: completedFinalCheck(ran.value, steps.length) });
};

const redCommittedHandler: Handler = async (ctx, ref, build) => {
	const ran = await runPolicyChecks(ctx, ref, worktreeOf(ctx, ref.key), "worktree-red", "test");
	if (!ran.ok) return failed("check_runner_failed", ran.error.message);
	const last = ran.value.checks.at(-1);
	if (!ran.value.final) {
		return {
			blocked: "red_check_incomplete",
			detail: "The install step failed",
			patch: { lastCheckId: last?.id ?? null },
		};
	}
	const check = ran.value.final;
	if (check.exitCode !== 0) {
		ctx.deps.storage.events.append({
			runId: ctx.runId,
			taskId: ref.task.id,
			type: "task.red_observed",
			payload: { checkId: check.id, commit: check.commitSha, exitCode: check.exitCode },
			now: ctx.deps.clock.now(),
		});
		return { next: "red_observed", patch: { lastCheckId: check.id } };
	}
	if (build.redRepairs >= 1) {
		return {
			blocked: "red_not_observed",
			detail: "The tests passed before any implementation",
			patch: { lastCheckId: check.id },
		};
	}
	const base = redPromptOf(ctx, ref);
	if (!base.ok) return asStep(base.error);
	const repaired = await redCommit(
		ctx,
		ref,
		{ ...build, redRepairs: 1 },
		redRepairPrompt(
			base.value,
			"The test command exited 0 although nothing was implemented: the tests do not fail.",
		),
		true,
	);
	return "next" in repaired
		? { ...repaired, patch: { ...repaired.patch, redRepairs: 1, lastCheckId: check.id } }
		: repaired;
};

const greenPromptOf = (
	ctx: TaskContext,
	ref: TaskRef,
	build: TaskBuild,
): Result<string, Failure<string>> => {
	const pack = packFor(ctx, ref);
	return pack.ok
		? ok(
				withGuidance(
					greenPrompt(
						{ key: ref.key, title: ref.task.title, acceptance: ref.task.acceptance },
						pack.value,
						build.testFiles,
					),
					operatorNote(ctx, ref),
				),
			)
		: pack;
};

const greenCommit = async (
	ctx: TaskContext,
	ref: TaskRef,
	build: TaskBuild,
	prompt: string,
	message: string,
	repair: boolean,
	kind: BuilderKind = "green",
): Promise<Step> => {
	const called = await builderCall(ctx, ref, { kind, repair, prompt });
	if (!called.ok) return called.error;
	const applied = applyChanges(ctx, ref, build, { message, lockedTests: build.testFiles });
	if (!applied.ok) return asStep(applied.error);
	return {
		next: "green_committed",
		patch: { ...applied.value.patch, headCommit: applied.value.commit },
	};
};

const redObservedHandler: Handler = async (ctx, ref, build) => {
	const prompt = greenPromptOf(ctx, ref, build);
	if (!prompt.ok) return asStep(prompt.error);
	return greenCommit(
		ctx,
		ref,
		build,
		prompt.value,
		`feat(${ref.key}): ${oneLine(ref.task.title)}`,
		false,
	);
};

const greenCommittedHandler: Handler = async (ctx, ref, build) => {
	const ran = await runPolicyChecks(ctx, ref, worktreeOf(ctx, ref.key), "worktree-green", "check");
	if (!ran.ok) return failed("check_runner_failed", ran.error.message);
	const last = ran.value.checks.at(-1);
	if (ran.value.final && ran.value.final.exitCode === 0) {
		const check = ran.value.final;
		const audited = await runDependencyAudit(ctx.deps, {
			runId: ctx.runId,
			taskId: ref.task.id,
			repoDir: worktreeOf(ctx, ref.key),
			cwdLabel: "worktree-audit",
			phase: "task",
			auditArgv: ctx.policy.audit,
		});
		if (!audited.ok) return failed("check_runner_failed", audited.error.message);
		if (audited.value.kind === "blocked") {
			return {
				blocked: "audit_new_vulnerability",
				detail: audited.value.detail,
				patch: { lastCheckId: check.id },
			};
		}
		const scanned = await runSastGate(ctx.deps, {
			runId: ctx.runId,
			taskId: ref.task.id,
			repoDir: worktreeOf(ctx, ref.key),
			cwdLabel: "worktree-sast",
			phase: "task",
			sastScript: ctx.policy.sast,
		});
		if (!scanned.ok) return failed("check_runner_failed", scanned.error.message);
		if (scanned.value.kind === "blocked") {
			return {
				blocked: "sast_new_finding",
				detail: scanned.value.detail,
				patch: { lastCheckId: check.id },
			};
		}
		ctx.deps.storage.events.append({
			runId: ctx.runId,
			taskId: ref.task.id,
			type: "task.green_observed",
			payload: { checkId: check.id, commit: check.commitSha },
			now: ctx.deps.clock.now(),
		});
		return { next: "green_observed", patch: { lastCheckId: check.id } };
	}
	const lastCheckId = last?.id ?? null;
	if (build.repairs >= ctx.repairsPerTask) {
		return {
			blocked: "green_not_reached",
			detail: `Checks still failing after ${build.repairs} repair(s)`,
			patch: { lastCheckId },
		};
	}
	const base = greenPromptOf(ctx, ref, build);
	if (!base.ok) return asStep(base.error);
	const attempt = build.repairs + 1;
	const repaired = await greenCommit(
		ctx,
		ref,
		build,
		greenRepairPrompt(base.value, {
			attempt,
			exitCode: last?.exitCode ?? -1,
			output: last ? logTail(ctx, last.logPath) : "(no check output)",
		}),
		`fix(${ref.key}): repair attempt ${attempt}`,
		true,
	);
	return "next" in repaired
		? { ...repaired, patch: { ...repaired.patch, repairs: attempt, lastCheckId } }
		: repaired;
};

type IntegrationOutcome =
	| { kind: "done"; checkId: string; integrationCommit: string }
	| { kind: "blocked"; reason: string; detail: string; checkId: string | null };

const integrateUnderLock = async (
	ctx: TaskContext,
	ref: TaskRef,
	preMerge: string,
	integrationCommit: string,
): Promise<Result<IntegrationOutcome, Failure<string>>> => {
	const { git, storage } = ctx.deps;
	const ran = await runPolicyChecks(ctx, ref, ctx.target, "integration", "check");
	const rollback = (): Failure<string> | undefined => {
		const reset = git.resetBranch({
			repoDir: ctx.target,
			runId: ctx.runId,
			branch: INTEGRATION_BRANCH,
			to: preMerge,
			holdsLock: true,
		});
		return reset.ok ? undefined : reset.error;
	};
	const blockWith = (reason: string, detail: string, checkId: string | null) => {
		const rolled = rollback();
		return rolled
			? fail<string>("integration_reset_failed", `${rolled.message} (while handling ${reason})`)
			: ok<IntegrationOutcome>({ kind: "blocked", reason, detail, checkId });
	};
	if (!ran.ok) return blockWith("integration_check_failed", ran.error.message, null);
	const check = ran.value.final;
	const evidence = assertDoneEvidence(check ? storage.checks.get(check.id) : undefined, {
		head: integrationCommit,
		taskId: ref.task.id,
		argv: ctx.policy.check,
	});
	if (!evidence.ok) {
		return blockWith(
			"integration_check_failed",
			evidence.error.message,
			ran.value.checks.at(-1)?.id ?? null,
		);
	}
	return ok({ kind: "done", checkId: evidence.value.id, integrationCommit });
};

const conflictOutcome = (preMerge: string, detail: string): IntegrationOutcome => ({
	kind: "blocked",
	reason: "merge_conflict",
	detail: `${detail} (integration stays at ${preMerge})`,
	checkId: null,
});

const outcomeToStep = (outcome: IntegrationOutcome, preMerge: string): Step =>
	outcome.kind === "done"
		? {
				done: true,
				patch: {
					preMergeCommit: preMerge,
					integrationCommit: outcome.integrationCommit,
					lastCheckId: outcome.checkId,
				},
			}
		: {
				blocked: outcome.reason,
				detail: outcome.detail,
				patch: { preMergeCommit: preMerge, lastCheckId: outcome.checkId },
			};

const isTaskMerge = (ctx: TaskContext, ref: TaskRef, head: string, pre: string): boolean => {
	const { git } = ctx.deps;
	const parents = git.parentsOf(ctx.target, head);
	const tip = git.branchHead(ctx.target, taskBranch(ctx, ref));
	return (
		parents.ok &&
		tip.ok &&
		tip.value !== null &&
		parents.value.length === 2 &&
		parents.value[0] === pre &&
		parents.value[1] === tip.value
	);
};

const STEPS_TO_REVIEWING: Partial<Record<Task["state"], readonly Task["state"][]>> = {
	RUNNING: ["VERIFYING", "REVIEWING"],
	REPAIRING: ["VERIFYING", "REVIEWING"],
	VERIFYING: ["REVIEWING"],
	REVIEWING: [],
};

const STEPS_TO_INTEGRATION: Partial<Record<Task["state"], readonly Task["state"][]>> = {
	RUNNING: ["VERIFYING"],
	REPAIRING: ["VERIFYING"],
	VERIFYING: [],
	REVIEWING: [],
};

const advanceTask = (
	ctx: TaskContext,
	taskId: string,
	routes: Partial<Record<Task["state"], readonly Task["state"][]>>,
): Result<void, Failure<string>> => {
	const current = ctx.deps.storage.tasks.get(taskId);
	if (!current) return fail("task_not_found", `Task ${taskId} not found`);
	const steps = routes[current.state];
	if (steps === undefined) {
		return fail("invalid_transition", `Task cannot continue the build from ${current.state}`);
	}
	for (const to of steps) {
		const moved = moveTask(ctx, taskId, to);
		if (!moved.ok) return moved;
	}
	return ok(undefined);
};

const greenObservedHandler: Handler = async () => ({ next: "reviewing" });

const reviewedHandler: Handler = async (ctx, ref, build) => {
	const verifying = advanceTask(ctx, ref.task.id, STEPS_TO_INTEGRATION);
	if (!verifying.ok) return asStep(verifying.error);
	const { git } = ctx.deps;
	const locked = await git.withMergeLock<Step, Failure<string>>(ctx.runId, async () => {
		const tip = git.branchHead(ctx.target, taskBranch(ctx, ref));
		if (!tip.ok) return fail(tip.error.code, tip.error.message);
		if (build.reviewedCommit === null || tip.value !== build.reviewedCommit) {
			return ok<Step>({
				blocked: "review_stale",
				detail: `The task branch is at ${tip.value ?? "nothing"} but the reviews cover ${build.reviewedCommit ?? "no commit"}`,
			});
		}
		const head = git.headSha(ctx.target);
		if (!head.ok) return fail("git_head_failed", head.error.message);
		const recorded = build.preMergeCommit;
		if (recorded !== null && head.value !== recorded) {
			if (!isTaskMerge(ctx, ref, head.value, recorded)) {
				return ok<Step>({
					blocked: "integration_head_moved",
					detail: `Integration moved from ${recorded} to ${head.value} before this task's merge was recorded; the task merge commit may be present in its history`,
				});
			}
			save(ctx, { ...build, phase: "merged", integrationCommit: head.value });
			const outcome = await integrateUnderLock(ctx, ref, recorded, head.value);
			return outcome.ok ? ok(outcomeToStep(outcome.value, recorded)) : outcome;
		}
		const pre = head;
		save(ctx, { ...build, preMergeCommit: pre.value });
		const merged = git.mergeNoFf({
			repoDir: ctx.target,
			runId: ctx.runId,
			into: INTEGRATION_BRANCH,
			from: taskBranch(ctx, ref),
			message: `merge(${ref.key}): ${oneLine(ref.task.title)}`,
			holdsLock: true,
		});
		if (!merged.ok) {
			if (merged.error.code !== "merge_conflict")
				return fail(merged.error.code, merged.error.message);
			const after = git.headSha(ctx.target);
			if (after.ok && after.value !== pre.value) {
				git.resetBranch({
					repoDir: ctx.target,
					runId: ctx.runId,
					branch: INTEGRATION_BRANCH,
					to: pre.value,
					holdsLock: true,
				});
			}
			return ok(outcomeToStep(conflictOutcome(pre.value, merged.error.message), pre.value));
		}
		save(ctx, {
			...build,
			phase: "merged",
			preMergeCommit: pre.value,
			integrationCommit: merged.value,
		});
		const outcome = await integrateUnderLock(ctx, ref, pre.value, merged.value);
		return outcome.ok ? ok(outcomeToStep(outcome.value, pre.value)) : outcome;
	});
	return locked.ok ? locked.value : asStep(locked.error);
};

const mergedHandler: Handler = async (ctx, ref, build) => {
	const verifying = advanceTask(ctx, ref.task.id, STEPS_TO_INTEGRATION);
	if (!verifying.ok) return asStep(verifying.error);
	const { git } = ctx.deps;
	const pre = build.preMergeCommit;
	const integration = build.integrationCommit;
	if (pre === null || integration === null) {
		return failed("build_record_corrupt", "A merged build record lacks its merge commits");
	}
	const locked = await git.withMergeLock<Step, Failure<string>>(ctx.runId, async () => {
		const head = git.headSha(ctx.target);
		if (!head.ok) return fail("git_head_failed", head.error.message);
		if (head.value !== integration) {
			return ok<Step>({
				blocked: "integration_head_moved",
				detail: `Integration moved from ${integration} to ${head.value} before the check completed; the task merge commit ${integration} may be present in its history`,
			});
		}
		const outcome = await integrateUnderLock(ctx, ref, pre, integration);
		return outcome.ok ? ok(outcomeToStep(outcome.value, pre)) : outcome;
	});
	return locked.ok ? locked.value : asStep(locked.error);
};

const findingForRepair = (
	finding: Omit<FindingForRepair, "evidence">,
	evidence: readonly string[],
): FindingForRepair => ({ ...finding, evidence: [...evidence] });

const reviewingHandler: Handler = async (ctx, ref, build) => {
	const { storage, git } = ctx.deps;
	const head = build.headCommit;
	if (head === null)
		return failed("build_record_corrupt", "A reviewing build record lacks its head");
	const entered = advanceTask(ctx, ref.task.id, STEPS_TO_REVIEWING);
	if (!entered.ok) return asStep(entered.error);
	const evidence = assertDoneEvidence(
		build.lastCheckId === null ? undefined : storage.checks.get(build.lastCheckId),
		{ head, taskId: ref.task.id, argv: ctx.policy.check },
	);
	const pack = packFor(ctx, ref);
	if (!pack.ok) return asStep(pack.error);
	const result = await runReviews(ctx.deps, {
		runId: ctx.runId,
		target: ctx.target,
		task: ref.task,
		key: ref.key,
		build,
		head,
		cycle: storage.retries.count(ref.task.id),
		diffMaxBytes: ctx.reviewDiffMaxBytes,
		pack: pack.value,
		greenEvidence: evidence.ok,
		budget: ctx.budget,
		repairBudgetRemains: build.repairs < ctx.repairsPerTask,
		templateId: ctx.policy.templateId,
		preview: ctx.policy.preview,
	});
	if (result.kind === "stop") {
		return {
			stop: result.reason,
			detail: result.detail,
			...(result.info === undefined ? {} : { info: result.info }),
		};
	}
	if (result.kind === "blocked") return { blocked: result.reason, detail: result.detail };
	if (result.kind === "pass") {
		const worktreeHead = git.headSha(worktreeOf(ctx, ref.key));
		const tip = git.branchHead(ctx.target, taskBranch(ctx, ref));
		const unchanged =
			worktreeHead.ok && tip.ok && worktreeHead.value === head && tip.value === head;
		return unchanged
			? { next: "reviewed", patch: { reviewedCommit: head } }
			: { blocked: "review_stale", detail: `The task branch moved while ${head} was under review` };
	}
	if (build.repairs >= ctx.repairsPerTask) {
		return {
			blocked: "review_findings_open",
			detail: `${result.open.length} critical/high finding(s) still open after ${build.repairs} repair(s)`,
		};
	}
	const repairing = moveTask(ctx, ref.task.id, "REPAIRING");
	if (!repairing.ok) return asStep(repairing.error);
	const base = greenPromptOf(ctx, ref, build);
	if (!base.ok) return asStep(base.error);
	const attempt = build.repairs + 1;
	const repaired = await greenCommit(
		ctx,
		ref,
		build,
		findingsRepairPrompt(base.value, {
			attempt,
			findings: result.open.map((finding) =>
				findingForRepair(finding, result.evidence[finding.uid] ?? []),
			),
			instructions: result.instructions,
		}),
		`fix(${ref.key}): resolve review findings (attempt ${attempt})`,
		true,
		"findings",
	);
	return "next" in repaired
		? { ...repaired, patch: { ...repaired.patch, repairs: attempt } }
		: repaired;
};

const HANDLERS: Record<Exclude<BuildPhase, "done" | "blocked">, Handler> = {
	started: startedHandler,
	red_committed: redCommittedHandler,
	red_observed: redObservedHandler,
	green_committed: greenCommittedHandler,
	green_observed: greenObservedHandler,
	reviewing: reviewingHandler,
	reviewed: reviewedHandler,
	merged: mergedHandler,
};

const cleanupWorktree = (ctx: TaskContext, ref: TaskRef): void => {
	const removed = ctx.deps.git.worktreeRemove({
		repoDir: ctx.target,
		runId: ctx.runId,
		taskKey: ref.key,
	});
	if (!removed.ok) {
		ctx.deps.storage.events.append({
			runId: ctx.runId,
			taskId: ref.task.id,
			type: "task.phase_changed",
			payload: { phase: "cleanup_failed", error: removed.error.message },
			now: ctx.deps.clock.now(),
		});
	}
};

const BLOCKED_DIFF_MAX_BYTES = 512 * 1024;

const saveBlockedDiff = (ctx: TaskContext, ref: TaskRef, build: TaskBuild): void => {
	const { git, storage, clock } = ctx.deps;
	const worktree = worktreeOf(ctx, ref.key);
	if (!existsSync(worktree)) return;
	const note = (error: string) =>
		storage.events.append({
			runId: ctx.runId,
			taskId: ref.task.id,
			type: "task.phase_changed",
			payload: { phase: "blocked_diff_unavailable", error },
			now: clock.now(),
		});
	const diff = git.diffWorktree(worktree, build.baseCommit, BLOCKED_DIFF_MAX_BYTES);
	if (!diff.ok) {
		note(diff.error.message);
		return;
	}
	if (diff.value.text.trim() === "") return;
	const redacted = redactDiff(diff.value.text);
	if (redacted.rules.length > 0) {
		storage.events.append({
			runId: ctx.runId,
			taskId: ref.task.id,
			type: "task.phase_changed",
			payload: { phase: "blocked_diff_redacted", rules: redacted.rules },
			now: clock.now(),
		});
	}
	const version =
		(storage.artifacts.latest(ctx.runId, "blocked-diff", ref.task.id)?.version ?? 0) + 1;
	const recorded = recordArtifacts(
		ctx.deps,
		ctx.runId,
		[
			{
				kind: "blocked-diff",
				subject: ref.task.id,
				version,
				path: `blocked-diff/${ref.task.id}-v${version}.patch`,
				content: diff.value.truncated
					? `${redacted.text}\n[truncated at ${BLOCKED_DIFF_MAX_BYTES} bytes]\n`
					: redacted.text,
				producer: "engine",
			},
		],
		() => ok(undefined),
	);
	if (!recorded.ok) note(recorded.error.message);
};

const finishBlocked = (
	ctx: TaskContext,
	ref: TaskRef,
	build: TaskBuild,
	step: { blocked: string; detail?: string },
): TaskReport => {
	const saved = save(ctx, { ...build, phase: "blocked", blockedReason: step.blocked });
	ctx.deps.storage.events.append({
		runId: ctx.runId,
		taskId: ref.task.id,
		type: "task.blocked",
		payload: { reason: step.blocked, detail: step.detail ?? null, lastCheckId: saved.lastCheckId },
		now: ctx.deps.clock.now(),
	});
	moveTask(ctx, ref.task.id, "BLOCKED");
	saveBlockedDiff(ctx, ref, saved);
	cleanupWorktree(ctx, ref);
	return { key: ref.key, outcome: "blocked", reason: step.blocked, lastCheckId: saved.lastCheckId };
};

const finishDone = (
	ctx: TaskContext,
	ref: TaskRef,
	build: TaskBuild,
): TaskReport | Failure<string> => {
	const evidence = assertDoneEvidence(
		build.lastCheckId === null ? undefined : ctx.deps.storage.checks.get(build.lastCheckId),
		{ head: build.integrationCommit ?? "", taskId: ref.task.id, argv: ctx.policy.check },
	);
	if (!evidence.ok) return evidence.error;
	const parents = ctx.deps.git.parentsOf(ctx.target, build.integrationCommit ?? "");
	if (!parents.ok || build.reviewedCommit === null || parents.value[1] !== build.reviewedCommit) {
		return {
			code: "review_stale",
			message: `The merged task head is not the reviewed commit ${build.reviewedCommit ?? "(none)"}`,
		};
	}
	const saved = save(ctx, { ...build, phase: "done", blockedReason: null });
	ctx.deps.storage.events.append({
		runId: ctx.runId,
		taskId: ref.task.id,
		type: "task.integrated",
		payload: {
			integrationCommit: saved.integrationCommit,
			preMergeCommit: saved.preMergeCommit,
			checkId: saved.lastCheckId,
			requiresReview: saved.requiresReview,
			reviewPaths: saved.protectedPaths,
			reviewedCommit: saved.reviewedCommit,
		},
		now: ctx.deps.clock.now(),
	});
	const moved = moveTask(ctx, ref.task.id, "DONE");
	if (!moved.ok) return moved.error;
	cleanupWorktree(ctx, ref);
	return { key: ref.key, outcome: "done", reason: null, lastCheckId: saved.lastCheckId };
};

const restoreStaleWorktree = (
	ctx: TaskContext,
	ref: TaskRef,
	build: TaskBuild,
): Result<void, Failure<string>> => {
	const worktree = worktreeOf(ctx, ref.key);
	if (!existsSync(worktree)) return ok(undefined);
	const expected = build.headCommit ?? build.baseCommit;
	const { git, storage, clock } = ctx.deps;
	const head = git.headSha(worktree);
	const clean = git.isClean(worktree);
	if (head.ok && clean.ok && head.value === expected && clean.value) return ok(undefined);
	const restored = git.restoreWorktree(worktree, expected);
	if (!restored.ok) return fail("worktree_restore_failed", restored.error.message);
	storage.events.append({
		runId: ctx.runId,
		taskId: ref.task.id,
		type: "task.phase_changed",
		payload: {
			phase: "worktree_restored",
			to: expected,
			discardedHead: head.ok && head.value !== expected ? head.value : null,
		},
		now: clock.now(),
	});
	return ok(undefined);
};

export type TaskResult = {
	report: TaskReport;
	stop?: { reason: StopReason; detail?: string; info?: StopInfo };
};

const ended = (report: TaskReport): TaskResult => ({ report });

export const processTask = async (ctx: TaskContext, ref: TaskRef): Promise<TaskResult> => {
	const { storage, clock } = ctx.deps;
	let build = storage.taskBuilds.get(ref.task.id);
	if (!build) {
		const base = ctx.deps.git.headSha(ctx.target);
		if (!base.ok) return ended(finishUnbuilt(ctx, ref, "git_head_failed", base.error.message));
		build = save(ctx, {
			taskId: ref.task.id,
			runId: ctx.runId,
			phase: "started",
			baseCommit: base.value,
			redCommit: null,
			headCommit: null,
			preMergeCommit: null,
			integrationCommit: null,
			reviewedCommit: null,
			testFiles: [],
			redRepairs: 0,
			repairs: 0,
			requiresReview: false,
			protectedPaths: [],
			blockedReason: null,
			lastCheckId: null,
			updatedAt: clock.now(),
		});
	}
	const running = moveTask(ctx, ref.task.id, "RUNNING");
	if (!running.ok) {
		return ended(finishUnbuilt(ctx, ref, running.error.code, running.error.message));
	}
	const canceled = (): TaskResult => {
		releaseTask(ctx.deps, { taskId: ref.task.id, owner: ctx.owner });
		return {
			stop: { reason: "run_canceled", detail: "The run was canceled" },
			report: {
				key: ref.key,
				outcome: "released",
				reason: "run_canceled",
				lastCheckId: build?.lastCheckId ?? null,
			},
		};
	};
	for (;;) {
		if (isRunCanceled(ctx.deps, ctx.runId)) return canceled();
		const beat = heartbeatTask(ctx.deps, {
			taskId: ref.task.id,
			owner: ctx.owner,
			ttlMs: LEASE_TTL_MS,
		});
		if (!beat.ok) {
			return ended({
				key: ref.key,
				outcome: "released",
				reason: "lease_lost",
				lastCheckId: build.lastCheckId,
			});
		}
		if (build.phase === "done" || build.phase === "blocked") {
			return ended({
				key: ref.key,
				outcome: build.phase === "done" ? "done" : "blocked",
				reason: build.blockedReason,
				lastCheckId: build.lastCheckId,
			});
		}
		const restored = restoreStaleWorktree(ctx, ref, build);
		if (!restored.ok) {
			return ended(
				finishBlocked(ctx, ref, build, {
					blocked: restored.error.code,
					detail: restored.error.message,
				}),
			);
		}
		const step = await HANDLERS[build.phase](ctx, ref, build);
		if ("blocked" in step && isRunCanceled(ctx.deps, ctx.runId)) return canceled();
		if ("stop" in step) {
			releaseTask(ctx.deps, { taskId: ref.task.id, owner: ctx.owner });
			return {
				stop: {
					reason: step.stop,
					...(step.detail === undefined ? {} : { detail: step.detail }),
					...(step.info === undefined ? {} : { info: step.info }),
				},
				report: {
					key: ref.key,
					outcome: "released",
					reason: step.stop,
					lastCheckId: build.lastCheckId,
				},
			};
		}
		if ("blocked" in step) {
			return ended(finishBlocked(ctx, ref, { ...build, ...step.patch }, step));
		}
		if ("done" in step) {
			const finished = finishDone(ctx, ref, { ...build, ...step.patch });
			if ("outcome" in finished) return ended(finished);
			return ended(
				finishBlocked(
					ctx,
					ref,
					{ ...build, ...step.patch },
					{ blocked: "done_transition_failed", detail: finished.message },
				),
			);
		}
		build = save(ctx, { ...build, ...step.patch, phase: step.next });
	}
};

const finishUnbuilt = (
	ctx: TaskContext,
	ref: TaskRef,
	reason: string,
	detail: string,
): TaskReport => {
	ctx.deps.storage.events.append({
		runId: ctx.runId,
		taskId: ref.task.id,
		type: "task.blocked",
		payload: { reason, detail, lastCheckId: null },
		now: ctx.deps.clock.now(),
	});
	releaseTask(ctx.deps, { taskId: ref.task.id, owner: ctx.owner });
	return { key: ref.key, outcome: "released", reason, lastCheckId: null };
};
