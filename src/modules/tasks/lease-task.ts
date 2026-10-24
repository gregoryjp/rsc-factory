import type { Task } from "../../contracts/entities.js";
import { type Failure, fail, ok, type Result } from "../../shared/result.js";
import type { AppDeps } from "../deps.js";
import type { StorageFailure } from "../storage.js";
import type { LeaseError } from "./ports.js";

export type LeaseTaskError = Failure<"task_not_found"> | LeaseError | StorageFailure;

export const claimTask = (
	deps: AppDeps,
	input: { taskId: string; owner: string; ttlMs: number },
): Result<Task, LeaseTaskError> =>
	deps.storage.transaction<Task, LeaseTaskError>(() => {
		const task = deps.storage.tasks.get(input.taskId);
		if (!task) return fail("task_not_found", `Task ${input.taskId} not found`);
		const now = deps.clock.now();
		const claimed = deps.storage.tasks.claim({
			taskId: task.id,
			owner: input.owner,
			expectedVersion: task.version,
			ttlMs: input.ttlMs,
			now,
		});
		if (!claimed.ok) return claimed;
		deps.storage.events.append({
			runId: task.runId,
			taskId: task.id,
			type: "task.leased",
			payload: {
				owner: input.owner,
				attempt: claimed.value.attempt,
				expiresAt: claimed.value.leaseExpiresAt,
			},
			now,
		});
		return ok(claimed.value);
	});

export const heartbeatTask = (
	deps: AppDeps,
	input: { taskId: string; owner: string; ttlMs: number },
): Result<Task, LeaseError | StorageFailure> =>
	deps.storage.transaction(() => deps.storage.tasks.heartbeat({ ...input, now: deps.clock.now() }));

export const releaseTask = (
	deps: AppDeps,
	input: { taskId: string; owner: string },
): Result<Task, LeaseError | StorageFailure> =>
	deps.storage.transaction<Task, LeaseError>(() => {
		const now = deps.clock.now();
		const released = deps.storage.tasks.release({ ...input, now });
		if (!released.ok) return released;
		deps.storage.events.append({
			runId: released.value.runId,
			taskId: released.value.id,
			type: "task.lease_released",
			payload: { owner: input.owner },
			now,
		});
		return released;
	});
