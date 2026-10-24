import { isTerminalRun } from "../../domain/run-machine.js";
import { type Failure, fail, ok, type Result } from "../../shared/result.js";
import { reconcileStaleReservations, STALE_RESERVATION_MS } from "../budget/reconcile.js";
import type { AppDeps } from "../deps.js";
import type { StorageFailure } from "../storage.js";
import { promoteReadyTasks } from "../tasks/promote-ready-tasks.js";
import { currentBlock, gateBlockedRun } from "./block-run.js";

export type ResumeRunError =
	| Failure<"run_not_found" | "run_terminal" | "version_conflict">
	| Failure<string>
	| StorageFailure;

export type ResumeSummary = { expiredTaskIds: string[]; readiedTaskIds: string[] };

export const resumeRun = (
	deps: AppDeps,
	input: { runId: string; force?: boolean },
): Result<ResumeSummary, ResumeRunError> =>
	deps.storage.transaction<ResumeSummary, ResumeRunError>(() => {
		const { storage, clock } = deps;
		const run = storage.runs.get(input.runId);
		if (!run) return fail("run_not_found", `Run ${input.runId} not found`);
		if (isTerminalRun(run.state)) return fail("run_terminal", `Run ${run.id} is ${run.state}`);

		const now = clock.now();
		reconcileStaleReservations(deps, {
			runId: run.id,
			staleAfterMs: STALE_RESERVATION_MS,
			now,
		});
		const block = currentBlock(storage, run.id);
		if (block?.cause === "quota_wait") {
			const gated = gateBlockedRun(deps, { runId: run.id, force: input.force === true });
			if (!gated.ok) return gated;
		}
		const expiredTaskIds: string[] = [];
		for (const task of storage.tasks.listExpiredLeases(run.id, now)) {
			const moved = storage.tasks.updateState({
				id: task.id,
				expectedVersion: task.version,
				to: "READY",
				now,
			});
			if (!moved.ok) return fail("version_conflict", moved.error.message);
			expiredTaskIds.push(task.id);
			storage.events.append({
				runId: run.id,
				taskId: task.id,
				type: "task.lease_expired",
				payload: { owner: task.leaseOwner, expiredAt: task.leaseExpiresAt },
				now,
			});
		}

		const promoted = promoteReadyTasks(deps, run.id);
		const readiedTaskIds = [...expiredTaskIds, ...promoted];
		storage.events.append({
			runId: run.id,
			type: "run.resumed",
			payload: { expiredTaskIds, promotedTaskIds: promoted },
			now,
		});
		return ok({ expiredTaskIds, readiedTaskIds });
	});
