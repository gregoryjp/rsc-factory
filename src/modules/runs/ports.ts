import type { Project, Run } from "../../contracts/entities.js";
import type { EventPayload, EventType, RunEvent } from "../../contracts/events.js";
import type { TargetKind } from "../../contracts/planning.js";
import type { DeliveryTarget, RunState } from "../../contracts/states.js";
import type { Failure, Result } from "../../shared/result.js";

export type ProjectRepository = {
	findByName: (name: string) => Project | undefined;
	findById: (id: string) => Project | undefined;
	insert: (project: Project) => void;
};

export type VersionedUpdateError = Failure<"version_conflict" | "not_found" | "lease_lost">;

export type RunRepository = {
	insert: (run: Run) => void;
	get: (id: string) => Run | undefined;
	setProviderMode: (id: string, mode: "real" | "fake") => void;
	setPresets: (id: string, presetIds: string[]) => void;
	setDeliveryTarget: (id: string, target: DeliveryTarget) => void;
	findActiveByInput: (projectId: string, inputHash: string) => Run | undefined;
	findLatestByInput: (projectId: string, inputHash: string) => Run | undefined;
	updateState: (input: {
		id: string;
		expectedVersion: number;
		to: RunState;
		now: number;
	}) => Result<Run, VersionedUpdateError>;
};

export type EventLog = {
	append: (input: {
		runId: string;
		taskId?: string;
		type: EventType;
		payload?: EventPayload;
		now: number;
	}) => RunEvent;
	list: (runId: string, options: { lastN?: number }) => RunEvent[];
};

export type PrdReadError = Failure<
	"prd_not_found" | "prd_not_regular_file" | "prd_unreadable" | "prd_empty" | "prd_too_large"
>;

export type PrdCopyError = Failure<"prd_copy_failed">;

export type PrdFiles = {
	read: (path: string) => Result<{ content: Buffer; hash: string }, PrdReadError>;
	persistCopy: (runId: string, content: Buffer) => Result<string, PrdCopyError>;
};

export type TargetError = Failure<
	"target_inside_factory" | "target_not_empty" | "target_not_directory" | "target_unresolvable"
>;

export type TargetRevalidationError = Failure<
	"target_inside_factory" | "target_unresolvable" | "target_changed"
>;

export type TargetFiles = {
	resolve: (path: string) => Result<{ path: string; kind: TargetKind }, TargetError>;
	revalidate: (expectedPath: string) => Result<void, TargetRevalidationError>;
};
