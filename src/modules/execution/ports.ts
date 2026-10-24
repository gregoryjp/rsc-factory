import type { Check } from "../../contracts/entities.js";
import type { ReviewArea, ReviewerOutput, Verdict } from "../../contracts/review.js";
import type { TemplateManifest } from "../../contracts/templates.js";
import type { UiEvidence } from "../../contracts/ui-evidence.js";
import type { ChangeStatus } from "../../domain/builder/protected-changes.js";
import type { PreviewPolicy } from "../../domain/checks/policy.js";
import type { FindingState } from "../../domain/review/types.js";
import type { UiAuth, UiRoute } from "../../domain/review/ui.js";
import type { ScanFile } from "../../domain/security/secret-scan.js";
import type { Failure, Result } from "../../shared/result.js";

export type GitFailureCode =
	| "git_failed"
	| "invalid_git_name"
	| "nothing_to_commit"
	| "merge_conflict"
	| "not_checked_out"
	| "worktree_exists"
	| "lock_held"
	| "lock_io"
	| "repo_config_tampered"
	| "repo_not_sealed"
	| "worktree_pointer_tampered"
	| "diff_too_large"
	| "unsafe_symlink";

export type GitError = Failure<GitFailureCode>;

export type GitPort = {
	init: (dir: string, branch: string) => Result<void, GitError>;
	configureIdentity: (dir: string, name: string, email: string) => Result<void, GitError>;
	stageAll: (dir: string) => Result<void, GitError>;
	unstageAll: (dir: string) => Result<void, GitError>;
	stagedFiles: (dir: string) => Result<ScanFile[], GitError>;
	commit: (dir: string, message: string) => Result<string, GitError>;
	sealRepo: (dir: string, expectedFingerprint?: string) => Result<void, GitError>;
	fingerprint: (dir: string) => Result<string, GitError>;
	snapshot: (repoDir: string, sha: string, destDir: string) => Result<void, GitError>;
	headSha: (dir: string) => Result<string, GitError>;
	remoteNames: (dir: string) => Result<string[], GitError>;
	statusPorcelainV2: (dir: string) => Result<string, GitError>;
	listFiles: (dir: string) => Result<string[], GitError>;
	isClean: (dir: string) => Result<boolean, GitError>;
	commitExists: (dir: string, sha: string) => Result<boolean, GitError>;
	worktreeAdd: (input: {
		repoDir: string;
		runId: string;
		taskKey: string;
		branch: string;
		baseSha: string;
	}) => Result<{ path: string }, GitError>;
	worktreeRemove: (input: {
		repoDir: string;
		runId: string;
		taskKey: string;
	}) => Result<void, GitError>;
	restoreWorktree: (dir: string, sha: string) => Result<void, GitError>;
	diffNames: (dir: string, base: string, head: string) => Result<string[], GitError>;
	diffText: (dir: string, base: string, head: string, maxBytes: number) => Result<string, GitError>;
	diffWorktree: (
		dir: string,
		base: string,
		maxBytes: number,
	) => Result<{ text: string; truncated: boolean }, GitError>;
	mergeNoFf: (input: {
		repoDir: string;
		runId: string;
		into: string;
		from: string;
		message?: string;
		holdsLock?: boolean;
	}) => Result<string, GitError>;
	resetBranch: (input: {
		repoDir: string;
		runId: string;
		branch: string;
		to: string;
		holdsLock?: boolean;
	}) => Result<void, GitError>;
	withMergeLock: <T, E>(
		runId: string,
		work: () => Promise<Result<T, E>>,
	) => Promise<Result<T, E | GitError>>;
	branchExists: (dir: string, branch: string) => Result<boolean, GitError>;
	checkoutBranch: (input: {
		repoDir: string;
		branch: string;
		createFromSha?: string;
	}) => Result<void, GitError>;
	statusEntries: (dir: string) => Result<{ path: string; status: ChangeStatus }[], GitError>;
	blobOid: (dir: string, rev: string, path: string) => Result<string | null, GitError>;
	showFile: (dir: string, rev: string, path: string) => Result<string | null, GitError>;
	parentsOf: (dir: string, rev: string) => Result<string[], GitError>;
	branchHead: (dir: string, branch: string) => Result<string | null, GitError>;
};

export type RunCheckInput = {
	runId: string;
	checkId?: string;
	cwd: string;
	argv: readonly string[];
	env: Readonly<Record<string, string>>;
	timeoutMs: number;
	signal?: AbortSignal;
};

export type CheckOutcome = {
	checkId: string;
	exitCode: number;
	durationMs: number;
	logPath: string;
	logSha256: string;
	tail: string;
	timedOut: boolean;
	killError: string | null;
	isolated: boolean;
};

export type RunnerError = Failure<
	"invalid_input" | "runner_unavailable" | "runner_failed" | "teardown_failed"
>;

export type CheckRunnerPort = {
	kind: "docker" | "host";
	isolated: boolean;
	runCheck: (input: RunCheckInput) => Promise<Result<CheckOutcome, RunnerError>>;
	teardown: (runId: string) => Promise<Result<void, RunnerError>>;
};

export type CheckRepository = {
	insert: (check: Check) => void;
	get: (id: string) => Check | undefined;
	listByRun: (runId: string) => Check[];
};

export type TemplateFile = { path: string; content: Buffer };

export type LoadedTemplate = { manifest: TemplateManifest; files: TemplateFile[] };

export type TemplateError = Failure<"template_not_found" | "template_invalid">;

export type TemplateStore = {
	load: (templateId: string) => Result<LoadedTemplate, TemplateError>;
};

export type TargetWriteError = Failure<"target_write_failed" | "cross_device">;

export type TargetWriter = {
	writeFile: (
		root: string,
		relativePath: string,
		content: Buffer,
	) => Result<void, TargetWriteError>;
	makeDirectory: (path: string) => Result<void, TargetWriteError>;
	renameDirectory: (from: string, to: string) => Result<void, TargetWriteError>;
	copyDirectory: (from: string, to: string) => Result<void, TargetWriteError>;
	removeDirectory: (path: string) => Result<void, TargetWriteError>;
	removeEmptyDirectory: (path: string) => Result<void, TargetWriteError>;
};

export type BuildPhase =
	| "started"
	| "red_committed"
	| "red_observed"
	| "green_committed"
	| "green_observed"
	| "reviewing"
	| "reviewed"
	| "merged"
	| "done"
	| "blocked";

export type TaskBuild = {
	taskId: string;
	runId: string;
	phase: BuildPhase;
	baseCommit: string;
	redCommit: string | null;
	headCommit: string | null;
	preMergeCommit: string | null;
	integrationCommit: string | null;
	reviewedCommit: string | null;
	testFiles: string[];
	redRepairs: number;
	repairs: number;
	requiresReview: boolean;
	protectedPaths: string[];
	blockedReason: string | null;
	lastCheckId: string | null;
	updatedAt: number;
};

export type TaskBuildRepository = {
	get: (taskId: string) => TaskBuild | undefined;
	upsert: (build: TaskBuild) => void;
	remove: (taskId: string) => void;
	listByRun: (runId: string) => TaskBuild[];
};

export type StoredReview = {
	id: string;
	runId: string;
	taskId: string;
	cycle: number;
	round: number;
	area: ReviewArea;
	commitSha: string;
	specVersion: number;
	verdict: Verdict;
	reason: string | null;
	acks: { path: string; decision: "ok" | "finding" }[];
	output: ReviewerOutput;
	artifactId: string | null;
	createdAt: number;
};

export type StoredFinding = FindingState & {
	id: string;
	runId: string;
	taskId: string;
	cycle: number;
	round: number;
	commitSha: string;
	createdAt: number;
};

export type ReviewRepository = {
	insertReview: (review: StoredReview) => void;
	listReviews: (taskId: string, cycle: number) => StoredReview[];
	replaceFindings: (input: {
		runId: string;
		taskId: string;
		cycle: number;
		round: number;
		commitSha: string;
		findings: readonly FindingState[];
		newId: () => string;
		now: number;
	}) => void;
	listFindings: (taskId: string, cycle: number, commitSha?: string) => StoredFinding[];
	listFindingsByRun: (runId: string) => StoredFinding[];
};

export type RetryRepository = {
	insert: (input: {
		runId: string;
		taskId: string;
		reason: string;
		note: string | null;
		now: number;
	}) => void;
	count: (taskId: string) => number;
	latestNote: (taskId: string) => string | null;
};

export type PreviewRequest = {
	runId: string;
	commitSha: string;
	productDir: string;
	policy: PreviewPolicy;
	routes: readonly UiRoute[];
	auth: UiAuth | null;
	outDir: string;
};

export type PreviewOutcome =
	| { status: "captured"; evidence: UiEvidence; evidencePath: string; teardownError: string | null }
	| { status: "unavailable"; reason: string };

export type PreviewPort = {
	capture: (request: PreviewRequest) => Promise<PreviewOutcome>;
};
