import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { z } from "zod";
import type { Task } from "../../contracts/entities.js";
import type { Role } from "../../contracts/planning.js";
import {
	type ApproverOutput,
	ApproverOutputSchema,
	type RefuterOutput,
	RefuterOutputSchema,
	type ReviewArea,
	type ReviewerOutput,
	ReviewerOutputSchema,
} from "../../contracts/review.js";
import type { PreviewPolicy } from "../../domain/checks/policy.js";
import type { GateFailure } from "../../domain/planning/gates.js";
import { dedupFindings } from "../../domain/review/dedup.js";
import { evaluateGate, gatePreconditions } from "../../domain/review/gate.js";
import {
	applyRefutation,
	type FindingState,
	isOpenSevere,
	type ReviewRecord,
	severeFindings,
	toState,
} from "../../domain/review/types.js";
import {
	checkRoutesAuth,
	evidencePromptView,
	parseUiAuth,
	parseUiRoutes,
	summarizeEvidence,
	uiApplicability,
	unavailableEntries,
} from "../../domain/review/ui.js";
import {
	validateApproverOutput,
	validateRefuterOutput,
	validateReviewerOutput,
} from "../../domain/review/validate.js";
import { type Failure, fail, ok, type Result } from "../../shared/result.js";
import { recordArtifacts } from "../planning/artifacts.js";
import type { PlanDeps, PlanError } from "../planning/deps.js";
import { callRole, READ_ONLY_PROFILE } from "../planning/run-role.js";
import type { PreviewOutcome, StoredReview, TaskBuild } from "./ports.js";
import type { CheckDeps } from "./record-check.js";
import {
	approverPrompt,
	type CheckSummary,
	type RequiresReviewEntry,
	refuterPrompt,
	reviewerPrompt,
	type UiEvidenceView,
} from "./review-prompts.js";
import { HALT_BY_ERROR_CODE, type HaltReason, type StopInfo, stopInfoOf } from "./stop.js";

export const DEFAULT_REVIEW_DIFF_MAX_BYTES = 200 * 1024;
export const REVIEW_AREAS: readonly ReviewArea[] = ["security", "code", "ux", "ui"];
const UI_AREAS: readonly ReviewArea[] = ["ux", "ui"];
const EVIDENCE_DIR = "ui-evidence";

const REVIEWER_ROLES: Record<ReviewArea, Role> = {
	security: "reviewer-security",
	code: "reviewer-code",
	ux: "reviewer-ux",
	ui: "reviewer-ui",
};

export type ReviewDeps = CheckDeps & PlanDeps;

export type ReviewInput = {
	runId: string;
	target: string;
	task: Task;
	key: string;
	build: TaskBuild;
	head: string;
	cycle: number;
	diffMaxBytes: number;
	pack: string;
	greenEvidence: boolean;
	budget: { used: number; max: number };
	repairBudgetRemains: boolean;
	templateId: string;
	preview: PreviewPolicy | undefined;
};

export type ReviewResult =
	| { kind: "pass" }
	| {
			kind: "repair";
			open: FindingState[];
			evidence: Record<string, string[]>;
			instructions: { findingIds: string[]; instruction: string }[];
	  }
	| { kind: "blocked"; reason: string; detail: string }
	| {
			kind: "stop";
			reason: "max_provider_calls" | "provider_unavailable" | HaltReason;
			detail: string;
			info?: StopInfo;
	  };

type Stage = Result<never, ReviewResult>;

const blocked = (reason: string, detail: string): Stage => ({
	ok: false,
	error: { kind: "blocked", reason, detail },
});

const roleFailure = (role: string, error: PlanError): Stage => {
	const halt = HALT_BY_ERROR_CODE[error.code];
	if (halt !== undefined) {
		return {
			ok: false,
			error: { kind: "stop", reason: halt, detail: error.message, info: stopInfoOf(error) },
		};
	}
	if (error.code === "provider_unavailable") {
		return {
			ok: false,
			error: { kind: "stop", reason: "provider_unavailable", detail: error.message },
		};
	}
	return blocked(
		error.code === "role_rejected" ? "review_output_invalid" : "review_blocked",
		`${role}: ${error.message}`,
	);
};

const spendCall = (input: ReviewInput): Stage | undefined => {
	if (input.budget.used >= input.budget.max) {
		return {
			ok: false,
			error: {
				kind: "stop",
				reason: "max_provider_calls",
				detail: "The provider-call budget is exhausted",
			},
		};
	}
	input.budget.used += 1;
	return undefined;
};

const reviewWorkDir = (deps: ReviewDeps, input: ReviewInput): string =>
	join(deps.factoryHome, "runs", input.runId, "review-work", deps.ids("rw"));

const approverWorkDir = (deps: ReviewDeps, input: ReviewInput): string =>
	join(deps.factoryHome, "runs", input.runId, "approver-work", deps.ids("aw"));

const callOnSnapshot = async <Raw, Value>(
	deps: ReviewDeps,
	input: ReviewInput,
	call: {
		role: Role;
		prompt: string;
		schema: z.ZodType<Raw>;
		gate: (raw: Raw) => Result<Value, GateFailure>;
		evidenceDir?: string;
	},
): Promise<Result<Value, ReviewResult>> => {
	const exhausted = spendCall(input);
	if (exhausted) return exhausted;
	const dir = reviewWorkDir(deps, input);
	try {
		const snap = deps.git.snapshot(input.target, input.head, dir);
		if (!snap.ok) return blocked("review_snapshot_failed", snap.error.message);
		if (call.evidenceDir !== undefined) {
			try {
				cpSync(call.evidenceDir, join(dir, EVIDENCE_DIR), { recursive: true });
			} catch (error) {
				return blocked(
					"review_snapshot_failed",
					error instanceof Error ? error.message : "could not copy the UI evidence",
				);
			}
		}
		const called = await callRole(deps, {
			runId: input.runId,
			role: call.role,
			cwd: dir,
			prompt: call.prompt,
			schema: call.schema,
			gate: call.gate,
			profile: READ_ONLY_PROFILE,
		});
		return called.ok ? called : roleFailure(call.role, called.error);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

const reasonsOf = (deps: ReviewDeps, input: ReviewInput): Record<string, string> => {
	const reasons: Record<string, string> = {};
	for (const event of deps.storage.events.list(input.runId, {})) {
		if (event.taskId !== input.task.id || event.type !== "task.protected_change") continue;
		if (event.payload.severity !== "review") continue;
		const map = event.payload.reasons;
		if (typeof map !== "object" || map === null) continue;
		for (const [path, reason] of Object.entries(map)) {
			if (typeof reason === "string") reasons[path] = reason;
		}
	}
	return reasons;
};

const checksOf = (deps: ReviewDeps, input: ReviewInput): CheckSummary[] =>
	deps.storage.checks
		.listByRun(input.runId)
		.filter((check) => check.taskId === input.task.id && check.commitSha === input.head)
		.map((check) => ({
			argv: check.argv,
			exitCode: check.exitCode,
			durationMs: check.durationMs,
			commitSha: check.commitSha,
			status: check.exitCode === 0 ? "passed" : "failed",
		}));

const recordRoleArtifact = (
	deps: ReviewDeps,
	input: ReviewInput,
	subject: string,
	label: string,
	body: unknown,
): Result<string, Failure<string>> => {
	const version = (deps.storage.artifacts.latest(input.runId, "review", subject)?.version ?? 0) + 1;
	const recorded = recordArtifacts(
		deps,
		input.runId,
		[
			{
				kind: "review",
				subject,
				version,
				path: `reviews/${input.task.id}/${label}-v${version}.json`,
				content: `${JSON.stringify(body, null, 2)}\n`,
				producer: "engine",
			},
		],
		() => ok(undefined),
	);
	const artifact = recorded.ok ? recorded.value[0] : undefined;
	return recorded.ok && artifact
		? ok(artifact.id)
		: fail("artifact_failed", recorded.ok ? "review artifact missing" : recorded.error.message);
};

const toRecord = (review: StoredReview): ReviewRecord => ({
	area: review.area,
	verdict: review.verdict,
	reason: review.reason,
	commitSha: review.commitSha,
	acks: review.acks,
});

const persistReview = (
	deps: ReviewDeps,
	input: ReviewInput,
	round: number,
	area: ReviewArea,
	output: ReviewerOutput,
): Result<StoredReview, Failure<string>> => {
	const artifactId = recordRoleArtifact(deps, input, `${input.task.id}:${area}`, area, {
		area,
		commitSha: input.head,
		round,
		output,
	});
	if (!artifactId.ok) return artifactId;
	const stored: StoredReview = {
		id: deps.ids("rev"),
		runId: input.runId,
		taskId: input.task.id,
		cycle: input.cycle,
		round,
		area,
		commitSha: input.head,
		specVersion: deps.storage.specs.latestVersion(input.runId) ?? 0,
		verdict: output.verdict,
		reason: output.reason ?? null,
		acks: output.requiresReviewAck.map((ack) => ({ path: ack.path, decision: ack.decision })),
		output,
		artifactId: artifactId.value,
		createdAt: deps.clock.now(),
	};
	deps.storage.reviews.insertReview(stored);
	deps.storage.events.append({
		runId: input.runId,
		taskId: input.task.id,
		type: "task.review_recorded",
		payload: {
			area,
			verdict: output.verdict,
			commit: input.head,
			round,
			findings: output.findings.length,
			reviewId: stored.id,
		},
		now: deps.clock.now(),
	});
	return ok(stored);
};

const reviewerStage = async (
	deps: ReviewDeps,
	input: ReviewInput,
	round: number,
	area: ReviewArea,
	context: { diff: string; checks: CheckSummary[]; requires: RequiresReviewEntry[] },
	evidence: { dir: string; view: UiEvidenceView } | null = null,
): Promise<Result<StoredReview, ReviewResult>> => {
	const requiresPaths = area === "code" ? context.requires.map((entry) => entry.path) : [];
	const output = await callOnSnapshot(deps, input, {
		role: REVIEWER_ROLES[area],
		prompt: reviewerPrompt({
			area,
			task: { key: input.key, title: input.task.title, acceptance: input.task.acceptance },
			pack: input.pack,
			diff: context.diff,
			checks: context.checks,
			head: input.head,
			requiresReview: area === "code" ? context.requires : null,
			uiEvidence: evidence?.view ?? null,
		}),
		schema: ReviewerOutputSchema,
		gate: (raw) => validateReviewerOutput(raw, { area, requiresReviewPaths: requiresPaths }),
		...(evidence === null ? {} : { evidenceDir: evidence.dir }),
	});
	if (!output.ok) return output;
	const persisted = persistReview(deps, input, round, area, output.value);
	return persisted.ok ? persisted : blocked("review_persist_failed", persisted.error.message);
};

const mergedOf = (reviews: readonly StoredReview[]): FindingState[] =>
	dedupFindings(
		reviews.flatMap((review) =>
			review.output.findings.map((finding) => ({ area: review.area, finding })),
		),
	).map(toState);

const refute = async (
	deps: ReviewDeps,
	input: ReviewInput,
	findings: FindingState[],
): Promise<Result<FindingState[], ReviewResult>> => {
	const severe = severeFindings(findings);
	if (severe.length === 0) return ok(findings);
	const sent = severe.map((finding) => finding.uid);
	const outcome = await callOnSnapshot<RefuterOutput, RefuterOutput>(deps, input, {
		role: "review-refuter",
		prompt: refuterPrompt({
			task: { key: input.key, title: input.task.title, acceptance: input.task.acceptance },
			head: input.head,
			findings: severe,
		}),
		schema: RefuterOutputSchema,
		gate: (raw) => validateRefuterOutput(raw, sent),
	});
	if (!outcome.ok) return outcome;
	const subject = `${input.task.id}:refuter`;
	const recorded = recordRoleArtifact(deps, input, subject, "refuter", {
		commitSha: input.head,
		outcomes: outcome.value.outcomes,
	});
	if (!recorded.ok) return blocked("review_persist_failed", recorded.error.message);
	return ok(applyRefutation(findings, outcome.value.outcomes));
};

const approve = async (
	deps: ReviewDeps,
	input: ReviewInput,
	findings: FindingState[],
	checks: CheckSummary[],
): Promise<Result<ApproverOutput, ReviewResult>> => {
	const exhausted = spendCall(input);
	if (exhausted) return exhausted;
	const known = findings.map((finding) => finding.uid);
	const cwd = approverWorkDir(deps, input);
	mkdirSync(cwd, { recursive: true });
	const called = await callRole(deps, {
		runId: input.runId,
		role: "approver",
		cwd,
		prompt: approverPrompt({
			task: { key: input.key, title: input.task.title, acceptance: input.task.acceptance },
			head: input.head,
			findings,
			checks,
			coverage: {
				requirementIds: deps.storage.taskMeta.getByTask(input.task.id)?.requirementIds ?? [],
				testFiles: input.build.testFiles,
				checkPassed: input.greenEvidence,
			},
		}),
		schema: ApproverOutputSchema,
		gate: (raw) => validateApproverOutput(raw, known),
	});
	rmSync(cwd, { recursive: true, force: true });
	if (!called.ok) return roleFailure("approver", called.error);
	const recorded = recordRoleArtifact(deps, input, `${input.task.id}:approver`, "approver", {
		commitSha: input.head,
		output: called.value,
	});
	return recorded.ok ? ok(called.value) : blocked("review_persist_failed", recorded.error.message);
};

const engineOutput = (
	area: ReviewArea,
	verdict: "blocked" | "not_applicable",
	reason: string,
): ReviewerOutput => ({
	area,
	verdict,
	reason,
	findings: [],
	requiresReviewAck: [],
});

const unavailable = (reason: string): PreviewOutcome => ({ status: "unavailable", reason });

const captureEvidence = async (deps: ReviewDeps, input: ReviewInput): Promise<PreviewOutcome> => {
	if (!deps.preview) {
		return unavailable("no browser preview is available with the selected runner");
	}
	if (!input.preview) {
		return unavailable(`the check policy defines no preview for template ${input.templateId}`);
	}
	let routesText: string | null = null;
	if (input.preview.routesFile !== undefined) {
		const shown = deps.git.showFile(input.target, input.head, input.preview.routesFile);
		if (!shown.ok)
			return unavailable(`could not read ${input.preview.routesFile}: ${shown.error.message}`);
		routesText = shown.value;
	}
	const routes = parseUiRoutes(routesText);
	if (!routes.ok) return unavailable(routes.error.message);
	let authText: string | null = null;
	if (input.preview.authFile !== undefined) {
		const shown = deps.git.showFile(input.target, input.head, input.preview.authFile);
		if (!shown.ok)
			return unavailable(`could not read ${input.preview.authFile}: ${shown.error.message}`);
		authText = shown.value;
	}
	const auth = parseUiAuth(authText);
	if (!auth.ok) return unavailable(auth.error.message);
	const roleCheck = checkRoutesAuth(routes.value, auth.value);
	if (!roleCheck.ok) return unavailable(roleCheck.error.message);
	const dir = join(deps.factoryHome, "runs", input.runId, "preview-work", deps.ids("pv"));
	try {
		const snap = deps.git.snapshot(input.target, input.head, dir);
		if (!snap.ok) return unavailable(snap.error.message);
		const outcome = await deps.preview.capture({
			runId: input.runId,
			commitSha: input.head,
			productDir: dir,
			policy: input.preview,
			routes: routes.value,
			auth: auth.value,
			outDir: join(deps.factoryHome, "runs", input.runId, "ui", input.head),
		});
		if (outcome.status !== "captured") return outcome;
		const missing = unavailableEntries(outcome.evidence);
		return missing.length === 0
			? outcome
			: unavailable(`incomplete browser evidence: ${missing.slice(0, 3).join("; ")}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

const recordEvidence = (deps: ReviewDeps, input: ReviewInput, outcome: PreviewOutcome): void => {
	const payload =
		outcome.status === "captured"
			? {
					status: "captured",
					commit: input.head,
					dir: `runs/${input.runId}/ui/${input.head}`,
					evidenceSha256: createHash("sha256")
						.update(readFileSync(outcome.evidencePath))
						.digest("hex"),
					scriptSha256: outcome.evidence.scriptSha256,
					teardownError: outcome.teardownError,
					...summarizeEvidence(outcome.evidence),
				}
			: { status: "unavailable", commit: input.head, reason: outcome.reason };
	deps.storage.events.append({
		runId: input.runId,
		taskId: input.task.id,
		type: "task.ui_evidence",
		payload,
		now: deps.clock.now(),
	});
};

const uiStage = async (
	deps: ReviewDeps,
	input: ReviewInput,
	round: number,
	areas: readonly ReviewArea[],
	context: { diff: string; checks: CheckSummary[]; requires: RequiresReviewEntry[] },
	into: Map<ReviewArea, StoredReview>,
): Promise<Result<void, ReviewResult>> => {
	const names = deps.git.diffNames(input.target, input.build.baseCommit, input.head);
	if (!names.ok) return blocked("review_diff_failed", names.error.message);
	const applicability = uiApplicability({
		templateId: input.templateId,
		changedFiles: names.value,
	});
	const outcome = applicability.applies ? await captureEvidence(deps, input) : undefined;
	if (outcome) recordEvidence(deps, input, outcome);
	for (const area of areas) {
		if (outcome?.status === "captured") {
			const stored = await reviewerStage(deps, input, round, area, context, {
				dir: dirname(outcome.evidencePath),
				view: { dir: EVIDENCE_DIR, ...evidencePromptView(outcome.evidence) },
			});
			if (!stored.ok) return stored;
			into.set(area, stored.value);
			continue;
		}
		const output = applicability.applies
			? engineOutput(
					area,
					"blocked",
					`browser evidence unavailable: ${outcome?.status === "unavailable" ? outcome.reason : "unknown"}`,
				)
			: engineOutput(area, "not_applicable", applicability.reason);
		const persisted = persistReview(deps, input, round, area, output);
		if (!persisted.ok) return blocked("review_persist_failed", persisted.error.message);
		into.set(area, persisted.value);
	}
	return ok(undefined);
};

type RoundPlan = {
	round: number;
	reused: Map<ReviewArea, StoredReview>;
	toRun: ReviewArea[];
};

const isReusable = (review: StoredReview): boolean =>
	!(review.verdict === "blocked" && UI_AREAS.includes(review.area));

const planRound = (reviews: readonly StoredReview[], head: string): RoundPlan => {
	const existing = reviews.filter((review) => review.commitSha === head);
	const round =
		existing[0]?.round ?? reviews.reduce((max, review) => Math.max(max, review.round), 0) + 1;
	const reused = new Map<ReviewArea, StoredReview>();
	const toRun: ReviewArea[] = [];
	for (const area of REVIEW_AREAS) {
		const here = existing.find((review) => review.area === area && isReusable(review));
		if (here) reused.set(area, here);
		else toRun.push(area);
	}
	return { round, reused, toRun };
};

export const runReviews = async (deps: ReviewDeps, input: ReviewInput): Promise<ReviewResult> => {
	const prior = deps.storage.reviews.listReviews(input.task.id, input.cycle);
	const plan = planRound(prior, input.head);
	const diff = deps.git.diffText(
		input.target,
		input.build.baseCommit,
		input.head,
		input.diffMaxBytes,
	);
	if (!diff.ok) {
		return {
			kind: "blocked",
			reason: diff.error.code === "diff_too_large" ? "diff_too_large" : "review_diff_failed",
			detail: diff.error.message,
		};
	}
	const reasons = reasonsOf(deps, input);
	const context = {
		diff: diff.value,
		checks: checksOf(deps, input),
		requires: input.build.requiresReview
			? input.build.protectedPaths.map((path) => ({
					path,
					reason: reasons[path] ?? "flagged for explicit review",
				}))
			: [],
	};
	const roundReviews = new Map<ReviewArea, StoredReview>(plan.reused);
	for (const area of plan.toRun.filter((candidate) => !UI_AREAS.includes(candidate))) {
		const stored = await reviewerStage(deps, input, plan.round, area, context);
		if (!stored.ok) return stored.error;
		roundReviews.set(area, stored.value);
	}
	const uiAreas = plan.toRun.filter((candidate) => UI_AREAS.includes(candidate));
	if (uiAreas.length > 0) {
		const staged = await uiStage(deps, input, plan.round, uiAreas, context, roundReviews);
		if (!staged.ok) return staged.error;
	}
	const reviews = REVIEW_AREAS.flatMap((area) => {
		const found = roundReviews.get(area);
		return found ? [found] : [];
	});
	const gateInput = {
		headCommit: input.head,
		greenEvidence: input.greenEvidence,
		expectedAreas: REVIEW_AREAS,
		reviews: reviews.map(toRecord),
		requiresReviewPaths: context.requires.map((entry) => entry.path),
	};
	const record = (decision: string, extra: Record<string, unknown>) =>
		deps.storage.events.append({
			runId: input.runId,
			taskId: input.task.id,
			type: "task.review_gate",
			payload: { decision, commit: input.head, round: plan.round, ...extra },
			now: deps.clock.now(),
		});
	const early = gatePreconditions({
		...gateInput,
		findings: [],
		approver: null,
		repairBudgetRemains: input.repairBudgetRemains,
	});
	if (early?.decision === "blocked") {
		record("blocked", { reason: early.reason, detail: early.detail });
		return { kind: "blocked", reason: early.reason, detail: early.detail };
	}
	const merged = mergedOf(reviews);
	const refuted = await refute(deps, input, merged);
	if (!refuted.ok) return refuted.error;
	deps.storage.reviews.replaceFindings({
		runId: input.runId,
		taskId: input.task.id,
		cycle: input.cycle,
		round: plan.round,
		commitSha: input.head,
		findings: refuted.value,
		newId: () => deps.ids("fnd"),
		now: deps.clock.now(),
	});
	const approver = await approve(deps, input, refuted.value, context.checks);
	if (!approver.ok) return approver.error;
	const decision = evaluateGate({
		...gateInput,
		findings: refuted.value,
		approver: approver.value.recommendation,
		repairBudgetRemains: input.repairBudgetRemains,
	});
	record(decision.decision, {
		approver: approver.value.recommendation,
		...(decision.decision === "blocked"
			? { reason: decision.reason, detail: decision.detail }
			: {}),
		...(decision.decision === "repair" ? { open: decision.open } : {}),
	});
	if (decision.decision === "pass") return { kind: "pass" };
	if (decision.decision === "blocked") {
		return { kind: "blocked", reason: decision.reason, detail: decision.detail };
	}
	const severeOpen = refuted.value.filter(isOpenSevere);
	const open =
		severeOpen.length > 0 ? severeOpen : refuted.value.filter((f) => f.status === "open");
	return {
		kind: "repair",
		open,
		evidence: Object.fromEntries(
			open.map((finding) => [finding.uid, finding.sources.map((source) => source.evidence)]),
		),
		instructions:
			decision.open.length === 0
				? approver.value.repairTasks
				: approver.value.repairTasks.filter((task) =>
						task.findingIds.some((id) => decision.open.includes(id)),
					),
	};
};
