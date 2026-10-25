import { type Failure, fail, ok, type Result } from "../../shared/result.js";
import type { AppDeps } from "../deps.js";
import { transitionTask } from "../tasks/transition-task.js";

export const MAX_NOTE_CHARS = 2000;
export const DEFAULT_MAX_TASK_RETRIES = 2;

export const RETRYABLE_REASONS: readonly string[] = [
	"review_findings_open",
	"ui_config_invalid",
	"repairs_exhausted",
	"green_not_reached",
	"audit_new_vulnerability",
	"sast_new_finding",
	"red_not_observed",
	"red_not_test_only",
	"protected_change",
	"tests_tampered",
	"integration_check_failed",
	"merge_conflict",
];

export type RetrySummary = { key: string; retries: number; reason: string };

export const retryTask = (
	deps: AppDeps,
	input: { runId: string; taskKey: string; note?: string; maxRetries?: number; force?: boolean },
): Result<RetrySummary, Failure<string>> => {
	const { storage, clock } = deps;
	const note = input.note?.trim() ?? "";
	if (note.length > MAX_NOTE_CHARS) {
		return fail(
			"note_too_long",
			`The note has ${note.length} characters; the limit is ${MAX_NOTE_CHARS}`,
		);
	}
	return storage.transaction<RetrySummary, Failure<string>>(() => {
		const run = storage.runs.get(input.runId);
		if (!run) return fail("run_not_found", `Run ${input.runId} not found`);
		const meta = storage.taskMeta.listByRun(run.id).find((entry) => entry.key === input.taskKey);
		const task = meta ? storage.tasks.get(meta.taskId) : undefined;
		if (!meta || !task) {
			return fail("task_not_found", `Task ${input.taskKey} not found in ${run.id}`);
		}
		if (task.state !== "BLOCKED") {
			return fail("retry_not_allowed", `Task ${meta.key} is ${task.state}, not BLOCKED`);
		}
		if (run.state !== "BUILDING") {
			return fail("run_not_retryable", `Run ${run.id} is ${run.state}; retry needs a BUILDING run`);
		}
		const build = storage.taskBuilds.get(task.id);
		const reason = build?.blockedReason ?? meta.blockedReason ?? "unknown";
		const forced = input.force === true && !RETRYABLE_REASONS.includes(reason);
		if (!RETRYABLE_REASONS.includes(reason) && !forced) {
			return fail(
				"retry_not_allowed",
				`Task ${meta.key} is blocked by ${reason}, which is not retryable (an operator may override with --force after inspecting it)`,
			);
		}
		const used = storage.retries.count(task.id);
		const limit = input.maxRetries ?? DEFAULT_MAX_TASK_RETRIES;
		if (used >= limit) {
			return fail(
				"retry_limit",
				`Task ${meta.key} was already retried ${used} time(s); the limit is ${limit}`,
			);
		}
		storage.retries.insert({
			runId: run.id,
			taskId: task.id,
			reason,
			note: note === "" ? null : note,
			now: clock.now(),
		});
		storage.taskBuilds.remove(task.id);
		const moved = transitionTask(deps, { taskId: task.id, to: "READY" });
		if (!moved.ok) return moved;
		storage.events.append({
			runId: run.id,
			taskId: task.id,
			type: "task.retried",
			payload: {
				key: meta.key,
				reason,
				forced,
				note: note === "" ? null : note,
				retries: used + 1,
				previous: {
					phase: build?.phase ?? null,
					redCommit: build?.redCommit ?? null,
					headCommit: build?.headCommit ?? null,
					repairs: build?.repairs ?? 0,
					lastCheckId: build?.lastCheckId ?? null,
				},
			},
			now: clock.now(),
		});
		return ok({ key: meta.key, retries: used + 1, reason });
	});
};
