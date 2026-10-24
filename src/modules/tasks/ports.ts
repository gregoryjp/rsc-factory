import type { Task } from "../../contracts/entities.js";
import type { AttemptOutcome, TaskState } from "../../contracts/states.js";
import type { Failure, Result } from "../../shared/result.js";
import type { VersionedUpdateError } from "../runs/ports.js";

export type Attempt = {
	id: number;
	taskId: string;
	number: number;
	owner: string;
	outcome: AttemptOutcome;
	startedAt: number;
	endedAt: number | null;
};

export type NewTask = {
	id: string;
	runId: string;
	title: string;
	acceptance: string;
	state: "PENDING" | "READY";
	dependsOn: string[];
	now: number;
};

export type LeaseError = Failure<"not_claimable" | "not_lease_owner">;

export type TaskRepository = {
	insertMany: (tasks: NewTask[]) => void;
	get: (id: string) => Task | undefined;
	listByRun: (runId: string) => Task[];
	countByState: (runId: string) => Record<TaskState, number>;
	listAttempts: (taskId: string) => Attempt[];
	listExpiredLeases: (runId: string, now: number) => Task[];
	listPromotable: (runId: string) => Task[];
	listDependents: (taskId: string) => Task[];
	updateState: (input: {
		id: string;
		expectedVersion: number;
		to: TaskState;
		now: number;
		owner?: string;
	}) => Result<Task, VersionedUpdateError>;
	claim: (input: {
		taskId: string;
		owner: string;
		expectedVersion: number;
		ttlMs: number;
		now: number;
	}) => Result<Task, LeaseError>;
	heartbeat: (input: {
		taskId: string;
		owner: string;
		ttlMs: number;
		now: number;
	}) => Result<Task, LeaseError>;
	release: (input: { taskId: string; owner: string; now: number }) => Result<Task, LeaseError>;
};
