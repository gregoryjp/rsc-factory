import type { ParsedSast, SastFinding, SastSeverity } from "./parse.js";

export type SastCounts = Record<SastSeverity, number>;

type Findings = {
	counts: SastCounts;
	newSevere: SastFinding[];
	newOther: SastFinding[];
	acceptedBaseline: SastFinding[];
};

export type SastVerdict =
	| ({ status: "pass" } & Findings)
	| ({ status: "new_finding" } & Findings)
	| { status: "unavailable"; reason: string };

export const SAST_BASELINE_MISSING_REASON =
	"no SAST baseline was recorded for the pristine template";

const keyOf = (finding: SastFinding): string =>
	`${finding.rule}|${finding.file}|${finding.fingerprint}`;

export const countSastBySeverity = (findings: readonly SastFinding[]): SastCounts => {
	const counts: SastCounts = { low: 0, medium: 0, high: 0 };
	for (const finding of findings) counts[finding.severity] += 1;
	return counts;
};

export const evaluateSast = (
	parsed: ParsedSast,
	baseline: readonly SastFinding[] | null,
): SastVerdict => {
	if (parsed.status === "unavailable") return parsed;
	if (baseline === null) return { status: "unavailable", reason: SAST_BASELINE_MISSING_REASON };
	const known = new Set(baseline.map(keyOf));
	const fresh = parsed.findings.filter((finding) => !known.has(keyOf(finding)));
	const acceptedBaseline = parsed.findings.filter((finding) => known.has(keyOf(finding)));
	const newSevere = fresh.filter((finding) => finding.severity === "high");
	const newOther = fresh.filter((finding) => finding.severity !== "high");
	return {
		status: newSevere.length > 0 ? "new_finding" : "pass",
		counts: countSastBySeverity(parsed.findings),
		newSevere,
		newOther,
		acceptedBaseline,
	};
};
