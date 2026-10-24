import { type TaskState, TaskStateSchema } from "../contracts/states.js";
import { type Failure, fail, ok, type Result } from "../shared/result.js";

export const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
	PENDING: ["READY", "BLOCKED", "CANCELED"],
	READY: ["BLOCKED", "CANCELED"],
	LEASED: ["RUNNING", "READY", "FAILED", "CANCELED"],
	RUNNING: ["VERIFYING", "READY", "BLOCKED", "FAILED", "CANCELED"],
	VERIFYING: ["REVIEWING", "REPAIRING", "DONE", "READY", "BLOCKED", "FAILED", "CANCELED"],
	REVIEWING: ["REPAIRING", "DONE", "READY", "BLOCKED", "FAILED", "CANCELED"],
	REPAIRING: ["VERIFYING", "READY", "BLOCKED", "FAILED", "CANCELED"],
	BLOCKED: ["READY", "FAILED", "CANCELED"],
	DONE: [],
	FAILED: [],
	CANCELED: [],
};

export const isTerminalTask = (state: TaskState): boolean => TASK_TRANSITIONS[state].length === 0;

export const TERMINAL_TASK_STATES: readonly TaskState[] =
	TaskStateSchema.options.filter(isTerminalTask);

export const LEASE_HOLDING_STATES = [
	"LEASED",
	"RUNNING",
	"VERIFYING",
	"REVIEWING",
	"REPAIRING",
] as const satisfies readonly TaskState[];

export const holdsLease = (state: TaskState): boolean =>
	(LEASE_HOLDING_STATES as readonly TaskState[]).includes(state);

export const keepsLeaseAfter = holdsLease;

export type TaskTransitionError = Failure<"invalid_transition">;

export const transitionTask = (
	from: TaskState,
	to: TaskState,
): Result<TaskState, TaskTransitionError> =>
	TASK_TRANSITIONS[from].includes(to)
		? ok(to)
		: fail("invalid_transition", `Task cannot move from ${from} to ${to}`);
