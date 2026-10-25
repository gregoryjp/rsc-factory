import { join } from "node:path";
import type { Run } from "../../contracts/entities.js";
import type { RunEvent } from "../../contracts/events.js";
import type { RunState, TaskState } from "../../contracts/states.js";
import { type AuditSummary, summarizeAudit } from "../../domain/depaudit/summary.js";
import { type FallbackSummary, fallbacksOf } from "../../domain/provider/fallback.js";
import { deliveryStateOf } from "../../domain/report/delivery-state.js";
import { type SastSummary, summarizeSast } from "../../domain/sast/summary.js";
import { type Failure, fail, ok, type Result } from "../../shared/result.js";
import type { BudgetSummary } from "../budget/ports.js";
import type { AppDeps } from "../deps.js";
import type { SpecSummary } from "../planning/ports.js";
import type { Storage } from "../storage.js";
import { currentBlock } from "./block-run.js";

export type TaskReviewSummary = {
	key: string;
	reviews: { area: string; verdict: string; commit: string }[];
	openSevere: number;
	refuted: number;
	minor: number;
	acceptedOpen: number;
	ui?: { dir: string; pages: number; axeViolations: number; overflowPages: number };
};

export type RunStatus = {
	run: Run;
	planning: SpecSummary & {
		presets: string[];
		blockedTasks: { key: string; reason: string; blockedDiff?: string }[];
		reviewTasks: string[];
		reviews: TaskReviewSummary[];
	};
	dependencyAudit: AuditSummary;
	sastScan: SastSummary;
	delivery: {
		target: string | null;
		status: string;
		cause: string | null;
		reportPath: string | null;
		mainCommit: string | null;
	};
	taskCounts: Record<TaskState, number>;
	budget: BudgetSummary;
	quotaWait: { waitUntil: number | null } | null;
	fallbacks: FallbackSummary[];
	recentEvents: RunEvent[];
	nextStep: string;
};

const STATIC_NEXT_STEP: Record<Exclude<RunState, "BLOCKED">, string> = {
	CREATED: "Run `factory plan <runId>` to build the specification and the task graph.",
	INGESTING: "Ingesting the PRD.",
	SPECIFYING: "Writing the specification.",
	PLANNING:
		"Planning is complete when tasks are seeded; re-run `factory plan <runId>` to resume an interrupted plan, then `factory build <runId>` to build tasks.",
	BUILDING:
		"Tasks are being built. Re-run `factory build <runId>` to continue; use `factory resume` after an interruption.",
	VERIFYING: "Running deterministic checks.",
	REVIEWING: "Reviews in progress.",
	REPAIRING: "Repairing findings.",
	INTEGRATING: "Integrating approved work.",
	READY_FOR_RELEASE:
		"Ready for release. Run `factory deliver <runId>` to write the factory report and merge into main (delivery local); production stays disabled until a policy is configured.",
	RELEASING: "Release in progress.",
	SUCCEEDED: "Finished. Nothing left to do.",
	FAILED: "Failed. Inspect the latest events.",
	CANCELED: "Canceled. Start a new run with `factory start --prd <path> --new`.",
};

const blockedNextStep = (storage: Storage, run: Run, events: RunEvent[]): string => {
	const block = currentBlock(storage, run.id);
	if (block?.cause === "budget_exhausted" || block?.cause === "quota_wait") {
		return `Blocked. Cause: ${block.cause}. ${block.nextStep ?? ""}`.trim();
	}
	const blocking = events.findLast(
		(e) => e.type === "run.state_changed" && e.payload.to === "BLOCKED",
	);
	const reason = blocking?.payload.reason;
	const cause =
		typeof reason === "string" ? `Cause: ${reason}.` : "No cause recorded for this block.";
	return `Blocked. ${cause} \`factory resume\` only reconciles tasks and does not change the run state.`;
};

const uiSummary = (storage: Storage, runId: string, taskId: string): TaskReviewSummary["ui"] => {
	const event = storage.events
		.list(runId, {})
		.findLast((e) => e.taskId === taskId && e.type === "task.ui_evidence");
	const p = event?.payload;
	if (p?.status !== "captured") return undefined;
	const { dir, pages, axeViolations, overflowPages } = p;
	return typeof dir === "string" &&
		typeof pages === "number" &&
		typeof axeViolations === "number" &&
		typeof overflowPages === "number"
		? { dir, pages, axeViolations, overflowPages }
		: undefined;
};

const reviewSummaries = (storage: Storage, runId: string): TaskReviewSummary[] =>
	storage.taskMeta.listByRun(runId).flatMap((meta) => {
		const cycle = storage.retries.count(meta.taskId);
		const reviews = storage.reviews.listReviews(meta.taskId, cycle);
		const last = reviews.at(-1);
		if (!last) return [];
		const latest = [...new Set(reviews.map((review) => review.area))].flatMap((area) =>
			reviews.filter((review) => review.area === area).slice(-1),
		);
		const head = last.commitSha;
		const ui = uiSummary(storage, runId, meta.taskId);
		const findings = storage.reviews.listFindings(meta.taskId, cycle, head);
		const severe = findings.filter((f) => f.severity === "critical" || f.severity === "high");
		return [
			{
				key: meta.key,
				reviews: latest.map((review) => ({
					area: review.area,
					verdict: review.verdict,
					commit: review.commitSha,
				})),
				openSevere: severe.filter((f) => f.status === "open").length,
				refuted: severe.filter((f) => f.status === "refuted").length,
				minor: findings.length - severe.length,
				acceptedOpen:
					severe.filter((f) => f.status === "open").length === 0
						? findings.filter((f) => f.status === "open").length
						: 0,
				...(ui === undefined ? {} : { ui }),
			},
		];
	});

export const getRunStatus = (
	{ storage }: Pick<AppDeps, "storage">,
	input: { runId: string; eventLimit: number },
): Result<RunStatus, Failure<"run_not_found">> => {
	const run = storage.runs.get(input.runId);
	if (!run) return fail("run_not_found", `Run ${input.runId} not found`);
	const delivery = deliveryStateOf(storage.events.list(run.id, {}));
	return ok({
		run,
		delivery: {
			target: run.deliveryTarget,
			status: delivery.status,
			cause: delivery.cause,
			reportPath:
				delivery.reportCommit === null || run.targetPath === null
					? null
					: join(run.targetPath, "docs", "verification", "factory-report.md"),
			mainCommit: delivery.mainCommit,
		},
		planning: {
			...storage.specs.summary(run.id),
			presets: run.presetIds,
			blockedTasks: storage.taskMeta.listByRun(run.id).flatMap((m) => {
				const reason = m.blockedReason ?? storage.taskBuilds.get(m.taskId)?.blockedReason ?? null;
				if (reason === null) return [];
				const diff = storage.artifacts.latest(run.id, "blocked-diff", m.taskId);
				return [
					{
						key: m.key,
						reason,
						...(diff === undefined ? {} : { blockedDiff: `runs/${run.id}/${diff.path}` }),
					},
				];
			}),
			reviews: reviewSummaries(storage, run.id),
			reviewTasks: storage.taskBuilds
				.listByRun(run.id)
				.filter((build) => build.requiresReview)
				.map((build) => storage.taskMeta.getByTask(build.taskId)?.key ?? build.taskId),
		},
		dependencyAudit: summarizeAudit(storage.events.list(run.id, {})),
		sastScan: summarizeSast(storage.events.list(run.id, {})),
		taskCounts: storage.tasks.countByState(run.id),
		budget: storage.budgets.summary(run.id),
		quotaWait: (() => {
			const block = currentBlock(storage, run.id);
			return block?.cause === "quota_wait" ? { waitUntil: block.waitUntil } : null;
		})(),
		fallbacks: fallbacksOf(storage.events.list(run.id, {})),
		recentEvents: storage.events.list(run.id, { lastN: input.eventLimit }),
		nextStep:
			run.state === "BLOCKED"
				? blockedNextStep(storage, run, storage.events.list(run.id, {}))
				: STATIC_NEXT_STEP[run.state],
	});
};
