import type { Failure, Result } from "../shared/result.js";
import type { BudgetRepository } from "./budget/ports.js";
import type {
	CheckRepository,
	RetryRepository,
	ReviewRepository,
	TaskBuildRepository,
} from "./execution/ports.js";
import type {
	ArtifactRepository,
	RoleAttemptRepository,
	SpecRepository,
	TaskMetaRepository,
} from "./planning/ports.js";
import type { EventLog, ProjectRepository, RunRepository } from "./runs/ports.js";
import type { TaskRepository } from "./tasks/ports.js";

export type StorageFailure = Failure<"storage_error">;

export type Storage = {
	projects: ProjectRepository;
	runs: RunRepository;
	tasks: TaskRepository;
	events: EventLog;
	specs: SpecRepository;
	artifacts: ArtifactRepository;
	roleAttempts: RoleAttemptRepository;
	taskMeta: TaskMetaRepository;
	checks: CheckRepository;
	taskBuilds: TaskBuildRepository;
	reviews: ReviewRepository;
	retries: RetryRepository;
	budgets: BudgetRepository;
	transaction: <T, E>(work: () => Result<T, E>) => Result<T, E | StorageFailure>;
	appliedMigrations: () => number[];
	close: () => void;
};
