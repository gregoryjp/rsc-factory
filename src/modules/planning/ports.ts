import type {
	Artifact,
	ArtifactKind,
	Assumption,
	Contradiction,
	Decision,
	Requirement,
	Risk,
	Role,
	SpecOutput,
} from "../../contracts/planning.js";
import type { Failure, Result } from "../../shared/result.js";

export type SpecRows = {
	requirements: Requirement[];
	assumptions: Assumption[];
	contradictions: Contradiction[];
};

export type SpecSummary = {
	specVersion: number | null;
	requirements: number;
	assumptions: number;
	contradictions: number;
	criticalContradictions: number;
};

export type SpecRepository = {
	insertSpec: (runId: string, version: number, spec: SpecOutput) => void;
	getSpec: (runId: string, version: number) => SpecRows;
	latestVersion: (runId: string) => number | null;
	summary: (runId: string) => SpecSummary;
	insertDecisions: (runId: string, version: number, decisions: Decision[]) => void;
	listDecisions: (runId: string, version: number) => Decision[];
};

export type ArtifactRepository = {
	insert: (artifact: Artifact) => void;
	find: (
		runId: string,
		kind: ArtifactKind,
		subject: string,
		version: number,
	) => Artifact | undefined;
	latest: (runId: string, kind: ArtifactKind, subject: string) => Artifact | undefined;
	list: (runId: string) => Artifact[];
};

export type RoleAttemptOutcome =
	| "running"
	| "accepted"
	| "rejected_schema"
	| "rejected_gate"
	| "provider_failed";

export type RoleAttempt = {
	id: number;
	runId: string;
	role: Role;
	number: number;
	repair: boolean;
	model: string;
	promptFile: string;
	promptHash: string;
	outcome: RoleAttemptOutcome;
	costUsd: number | null;
	error: string | null;
	failureClass: string | null;
	tryNumber: number;
	startedAt: number;
	endedAt: number | null;
};

export type RoleAttemptRepository = {
	start: (input: {
		runId: string;
		role: Role;
		repair: boolean;
		model: string;
		promptFile: string;
		promptHash: string;
		tryNumber?: number;
		now: number;
	}) => number;
	finish: (
		id: number,
		input: {
			outcome: RoleAttemptOutcome;
			costUsd: number | null;
			error: string | null;
			failureClass?: string;
			now: number;
		},
	) => void;
	list: (runId: string) => RoleAttempt[];
};

export type TaskMeta = {
	taskId: string;
	runId: string;
	key: string;
	requirementIds: string[];
	risk: Risk;
	modelRisk: Risk;
	riskReasons: string[];
	expectedPaths: string[];
	blockedReason: string | null;
};

export type TaskMetaRepository = {
	insertMany: (metas: TaskMeta[]) => void;
	listByRun: (runId: string) => TaskMeta[];
	getByTask: (taskId: string) => TaskMeta | undefined;
};

export type FactoryFileError = Failure<"factory_file_unreadable">;

export type FactoryFiles = {
	read: (relativePath: string) => Result<{ content: string; sha256: string }, FactoryFileError>;
};

export type ArtifactStoreError = Failure<"artifact_io_failed" | "artifact_corrupted">;

export type ArtifactStore = {
	write: (
		runId: string,
		relativePath: string,
		content: string,
	) => Result<{ sha256: string; bytes: number }, ArtifactStoreError>;
	read: (runId: string, relativePath: string) => Result<Buffer, ArtifactStoreError>;
};
