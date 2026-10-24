import type {
	Confidence,
	RefutationOutcome,
	ReviewArea,
	Severity,
	Verdict,
} from "../../contracts/review.js";

export type FindingSource = {
	area: ReviewArea;
	id: string;
	evidence: string;
	evidenceRef?: string;
};

export type MergedFinding = {
	uid: string;
	severity: Severity;
	confidence: Confidence;
	title: string;
	file: string | null;
	lineStart: number | null;
	lineEnd: number | null;
	impact: string;
	recommendation: string;
	requirementIds: string[];
	sources: FindingSource[];
	conflictsWith: string[];
};

export type FindingStatus = "open" | "refuted";

export type Refutation = { outcome: RefutationOutcome; evidence: string };

export type FindingState = MergedFinding & {
	status: FindingStatus;
	refutation: Refutation | null;
};

export type ReviewRecord = {
	area: ReviewArea;
	verdict: Verdict;
	reason: string | null;
	commitSha: string;
	acks: { path: string; decision: "ok" | "finding" }[];
};

export const SEVERE: readonly Severity[] = ["critical", "high"];

export const isSevere = (severity: Severity): boolean => SEVERE.includes(severity);

export const toState = (finding: MergedFinding): FindingState => ({
	...finding,
	status: "open",
	refutation: null,
});

export const severeFindings = <T extends { severity: Severity }>(findings: readonly T[]): T[] =>
	findings.filter((finding) => isSevere(finding.severity));

export const applyRefutation = (
	findings: readonly FindingState[],
	outcomes: readonly { id: string; outcome: RefutationOutcome; evidence: string }[],
): FindingState[] => {
	const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome]));
	return findings.map((finding) => {
		const outcome = byId.get(finding.uid);
		if (!outcome) return finding;
		return {
			...finding,
			status: outcome.outcome === "refuted" ? "refuted" : "open",
			refutation: { outcome: outcome.outcome, evidence: outcome.evidence },
		};
	});
};

export const isOpenSevere = (finding: FindingState): boolean =>
	isSevere(finding.severity) && finding.status === "open";
