import type { Run } from "../../contracts/entities.js";
import { isTerminalRun } from "../../domain/run-machine.js";
import { isTerminalTask } from "../../domain/task-machine.js";
import { type Failure, fail, ok, type Result } from "../../shared/result.js";
import type { AppDeps } from "../deps.js";
import type { StorageFailure } from "../storage.js";

export type CancelRunError =
	| Failure<"run_not_found" | "run_terminal" | "version_conflict">
	| StorageFailure;

export const cancelRun = (
	{ storage, clock }: AppDeps,
	input: { runId: string },
): Result<{ run: Run; canceledTaskIds: string[] }, CancelRunError> =>
	storage.transaction<{ run: Run; canceledTaskIds: string[] }, CancelRunError>(() => {
		const run = storage.runs.get(input.runId);
		if (!run) return fail("run_not_found", `Run ${input.runId} not found`);
		if (isTerminalRun(run.state))
			return fail("run_terminal", `Run ${run.id} is already ${run.state}`);

		const now = clock.now();
		const canceled = storage.runs.updateState({
			id: run.id,
			expectedVersion: run.version,
			to: "CANCELED",
			now,
		});
		if (!canceled.ok) return fail("version_conflict", canceled.error.message);

		const canceledTaskIds: string[] = [];
		for (const task of storage.tasks.listByRun(run.id)) {
			if (isTerminalTask(task.state)) continue;
			const moved = storage.tasks.updateState({
				id: task.id,
				expectedVersion: task.version,
				to: "CANCELED",
				now,
			});
			if (!moved.ok) return fail("version_conflict", moved.error.message);
			canceledTaskIds.push(task.id);
			storage.events.append({
				runId: run.id,
				taskId: task.id,
				type: "task.state_changed",
				payload: { from: task.state, to: "CANCELED", leaseOwner: task.leaseOwner },
				now,
			});
		}
		storage.events.append({
			runId: run.id,
			type: "run.canceled",
			payload: { from: run.state, canceledTaskIds },
			now,
		});
		return ok({ run: canceled.value, canceledTaskIds });
	});
