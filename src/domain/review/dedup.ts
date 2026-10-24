import type { Finding, ReviewArea } from "../../contracts/review.js";
import { isSevere, type MergedFinding } from "./types.js";

export const LINE_WINDOW = 3;
export const TITLE_SIMILARITY_MIN = 0.5;

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 } as const;
const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 } as const;

const tokensOf = (title: string): Set<string> =>
	new Set(
		title
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((token) => token.length > 1),
	);

export const titleSimilarity = (a: string, b: string): number => {
	const left = tokensOf(a);
	const right = tokensOf(b);
	if (left.size === 0 || right.size === 0) return 0;
	const shared = [...left].filter((token) => right.has(token)).length;
	return shared / (left.size + right.size - shared);
};

type Located = { file: string | null; lineStart: number | null; lineEnd: number | null };

const sameLocation = (a: Located, b: Located): boolean => {
	if (a.file === null || b.file === null || a.file !== b.file) return false;
	if (a.lineStart === null || b.lineStart === null) return true;
	const aEnd = a.lineEnd ?? a.lineStart;
	const bEnd = b.lineEnd ?? b.lineStart;
	return a.lineStart - LINE_WINDOW <= bEnd && b.lineStart - LINE_WINDOW <= aEnd;
};

const similar = (a: MergedFinding, b: MergedFinding): boolean =>
	sameLocation(a, b) && titleSimilarity(a.title, b.title) >= TITLE_SIMILARITY_MIN;

const sameClass = (a: MergedFinding, b: MergedFinding): boolean =>
	isSevere(a.severity) === isSevere(b.severity);

const minOf = (a: number | null, b: number | null): number | null =>
	a === null || b === null ? null : Math.min(a, b);

const maxOf = (a: number | null, b: number | null): number | null =>
	a === null || b === null ? null : Math.max(a, b);

const merge = (into: MergedFinding, other: MergedFinding): MergedFinding => ({
	...into,
	severity:
		SEVERITY_RANK[other.severity] > SEVERITY_RANK[into.severity] ? other.severity : into.severity,
	confidence:
		CONFIDENCE_RANK[other.confidence] > CONFIDENCE_RANK[into.confidence]
			? other.confidence
			: into.confidence,
	lineStart: minOf(into.lineStart, other.lineStart),
	lineEnd: maxOf(into.lineEnd ?? into.lineStart, other.lineEnd ?? other.lineStart),
	requirementIds: [...new Set([...into.requirementIds, ...other.requirementIds])],
	sources: [...into.sources, ...other.sources],
});

const toMerged = (area: ReviewArea, finding: Finding, uid: string): MergedFinding => ({
	uid,
	severity: finding.severity,
	confidence: finding.confidence,
	title: finding.title,
	file: finding.file ?? null,
	lineStart: finding.lineStart ?? null,
	lineEnd: finding.lineEnd ?? finding.lineStart ?? null,
	impact: finding.impact,
	recommendation: finding.recommendation,
	requirementIds: finding.requirementIds ?? [],
	sources: [
		{
			area,
			id: finding.id,
			evidence: finding.evidence,
			...(finding.evidenceRef === undefined ? {} : { evidenceRef: finding.evidenceRef }),
		},
	],
	conflictsWith: [],
});

export const dedupFindings = (
	inputs: readonly { area: ReviewArea; finding: Finding }[],
): MergedFinding[] => {
	const merged: MergedFinding[] = [];
	for (const { area, finding } of inputs) {
		const candidate = toMerged(area, finding, `F${merged.length + 1}`);
		const index = merged.findIndex(
			(existing) => sameClass(existing, candidate) && similar(existing, candidate),
		);
		const existing = merged[index];
		if (existing) merged[index] = merge(existing, candidate);
		else merged.push(candidate);
	}
	return merged.map((finding) => ({
		...finding,
		conflictsWith: merged
			.filter(
				(other) =>
					other.uid !== finding.uid && !sameClass(other, finding) && similar(other, finding),
			)
			.map((other) => other.uid),
	}));
};
