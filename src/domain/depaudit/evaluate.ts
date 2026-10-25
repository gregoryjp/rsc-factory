import type { Advisory, AdvisorySeverity, ParsedAudit } from "./parse.js";

export type SeverityCounts = Record<AdvisorySeverity, number>;

type Findings = {
	counts: SeverityCounts;
	newSevere: Advisory[];
	newOther: Advisory[];
	acceptedBaseline: Advisory[];
};

export type AuditVerdict =
	| ({ status: "pass" } & Findings)
	| ({ status: "new_vulnerability" } & Findings)
	| { status: "unavailable"; reason: string };

export const BASELINE_MISSING_REASON = "no audit baseline was recorded for the pristine template";

const SEVERE: readonly AdvisorySeverity[] = ["high", "critical"];

const keyOf = (advisory: Advisory): string => `${advisory.id}|${advisory.package}`;

export const countBySeverity = (advisories: readonly Advisory[]): SeverityCounts => {
	const counts: SeverityCounts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
	for (const advisory of advisories) counts[advisory.severity] += 1;
	return counts;
};

export const evaluateAudit = (
	parsed: ParsedAudit,
	baseline: readonly Advisory[] | null,
): AuditVerdict => {
	if (parsed.status === "unavailable") return parsed;
	if (baseline === null) return { status: "unavailable", reason: BASELINE_MISSING_REASON };
	const known = new Set(baseline.map(keyOf));
	const fresh = parsed.advisories.filter((advisory) => !known.has(keyOf(advisory)));
	const acceptedBaseline = parsed.advisories.filter((advisory) => known.has(keyOf(advisory)));
	const newSevere = fresh.filter((advisory) => SEVERE.includes(advisory.severity));
	const newOther = fresh.filter((advisory) => !SEVERE.includes(advisory.severity));
	return {
		status: newSevere.length > 0 ? "new_vulnerability" : "pass",
		counts: countBySeverity(parsed.advisories),
		newSevere,
		newOther,
		acceptedBaseline,
	};
};
