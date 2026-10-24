import type { Task } from "../../contracts/entities.js";
import type { TaskState } from "../../contracts/states.js";
import {
	holdsLease,
	type TaskTransitionError,
	transitionTask as validateTransition,
} from "../../domain/task-machine.js";
import { type Failure, fail, ok, type Result } from "../../shared/result.js";
import type { AppDeps } from "../deps.js";
import type { VersionedUpdateError } from "../runs/ports.js";
import type { StorageFailure } from "../storage.js";
import { promoteReadyTasks } from "./promote-ready-tasks.js";

export type TransitionTaskError =
	| Failure<"task_not_found" | "lease_required">
	| TaskTransitionError
	| VersionedUpdateError
	| StorageFailure;

export const transitionTask = (
	deps: AppDeps,
	input: { taskId: string; to: TaskState; owner?: string; expectedVersion?: number },
): Result<Task, TransitionTaskError> =>
	deps.storage.transaction<Task, TransitionTaskError>(() => {
		const task = deps.storage.tasks.get(input.taskId);
		if (!task) return fail("task_not_found", `Task ${input.taskId} not found`);
		const allowed = validateTransition(task.state, input.to);
		if (!allowed.ok) return allowed;
		const leased = holdsLease(task.state);
		if (leased && (input.owner === undefined || input.expectedVersion === undefined)) {
			return fail(
				"lease_required",
				`Task ${task.id} is ${task.state}; owner and expectedVersion are required`,
			);
		}
		const now = deps.clock.now();
		const updated = deps.storage.tasks.updateState({
			id: task.id,
			expectedVersion: input.expectedVersion ?? task.version,
			to: input.to,
			now,
			...(leased && input.owner !== undefined ? { owner: input.owner } : {}),
		});
		if (!updated.ok) return updated;
		deps.storage.events.append({
			runId: task.runId,
			taskId: task.id,
			type: "task.state_changed",
			payload: { from: task.state, to: input.to },
			now,
		});
		if (input.to === "DONE") promoteReadyTasks(deps, task.runId);
		return ok(updated.value);
	});
