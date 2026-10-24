import type { ApproverRecommendation, ReviewArea } from "../../contracts/review.js";
import { type FindingState, isOpenSevere, type ReviewRecord } from "./types.js";

export type GateInput = {
	headCommit: string;
	greenEvidence: boolean;
	expectedAreas: readonly ReviewArea[];
	reviews: readonly ReviewRecord[];
	findings: readonly FindingState[];
	requiresReviewPaths: readonly string[];
	approver: ApproverRecommendation | null;
	repairBudgetRemains: boolean;
};

export type GateBlockReason =
	| "evidence_missing"
	| "review_stale"
	| "review_incomplete"
	| "review_blocked"
	| "review_unacknowledged"
	| "approver_blocked";

export type GateDecision =
	| { decision: "pass" }
	| { decision: "repair"; open: string[]; areas: ReviewArea[] }
	| { decision: "blocked"; reason: GateBlockReason; detail: string };

const blocked = (reason: GateBlockReason, detail: string): GateDecision => ({
	decision: "blocked",
	reason,
	detail,
});

const hasReason = (review: ReviewRecord): boolean =>
	review.reason !== null && review.reason.trim().length > 0;

const isStale = (review: ReviewRecord, head: string): boolean => review.commitSha !== head;

const unacknowledged = (input: GateInput): string[] => {
	const acked = new Set(input.reviews.flatMap((review) => review.acks.map((ack) => ack.path)));
	return input.requiresReviewPaths.filter((path) => !acked.has(path));
};

export const gatePreconditions = (input: GateInput): GateDecision | undefined => {
	if (!input.greenEvidence) {
		return blocked("evidence_missing", "No passing check on the reviewed head");
	}
	const missing = input.expectedAreas.filter(
		(area) => !input.reviews.some((review) => review.area === area),
	);
	if (missing.length > 0) {
		return blocked("review_incomplete", `Missing review(s): ${missing.join(", ")}`);
	}
	const stale = input.reviews.filter((review) => isStale(review, input.headCommit));
	if (stale.length > 0) {
		return blocked(
			"review_stale",
			`Review(s) not bound to ${input.headCommit}: ${stale.map((r) => r.area).join(", ")}`,
		);
	}
	const unable = input.reviews.filter((review) => review.verdict === "blocked");
	if (unable.length > 0) {
		return blocked(
			"review_blocked",
			`Reviewer(s) blocked: ${unable.map((r) => r.area).join(", ")}`,
		);
	}
	const noReason = input.reviews.filter(
		(review) => review.verdict === "not_applicable" && !hasReason(review),
	);
	if (noReason.length > 0) {
		return blocked(
			"review_incomplete",
			`not_applicable without a reason: ${noReason.map((r) => r.area).join(", ")}`,
		);
	}
	const missingAcks = unacknowledged(input);
	if (missingAcks.length > 0) {
		return blocked("review_unacknowledged", `Unacknowledged paths: ${missingAcks.join(", ")}`);
	}
	return undefined;
};

export const evaluateGate = (input: GateInput): GateDecision => {
	const early = gatePreconditions(input);
	if (early) return early;
	if (input.approver === null) {
		return blocked("review_incomplete", "The approver produced no recommendation");
	}
	if (input.approver === "block") {
		return blocked("approver_blocked", "The approver recommended blocking the task");
	}
	const open = input.findings.filter(isOpenSevere);
	if (open.length > 0) {
		const areas = [
			...new Set(open.flatMap((finding) => finding.sources.map((source) => source.area))),
		];
		return { decision: "repair", open: open.map((finding) => finding.uid), areas };
	}
	if (input.approver === "repair" && input.repairBudgetRemains) {
		return { decision: "repair", open: [], areas: [] };
	}
	return { decision: "pass" };
};
