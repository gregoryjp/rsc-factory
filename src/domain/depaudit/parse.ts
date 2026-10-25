import { z } from "zod";

export const AdvisorySeveritySchema = z.enum(["info", "low", "moderate", "high", "critical"]);
export type AdvisorySeverity = z.infer<typeof AdvisorySeveritySchema>;

export type Advisory = {
	id: string;
	package: string;
	severity: AdvisorySeverity;
	fixAvailable: boolean;
};

export type ParsedAudit =
	| { status: "parsed"; advisories: Advisory[] }
	| { status: "unavailable"; reason: string };

const ViaObject = z.looseObject({
	source: z.union([z.number(), z.string()]).optional(),
	name: z.string().optional(),
	url: z.string().optional(),
	severity: AdvisorySeveritySchema.optional(),
});

const VulnerabilityEntry = z.looseObject({
	name: z.string(),
	severity: AdvisorySeveritySchema,
	via: z.array(z.union([z.string(), ViaObject])).default([]),
	fixAvailable: z.union([z.boolean(), z.looseObject({})]).optional(),
});

const AuditReport = z.looseObject({
	vulnerabilities: z.record(z.string(), VulnerabilityEntry),
});

const ErrorReport = z.looseObject({
	error: z.looseObject({
		code: z.string().optional(),
		summary: z.string().optional(),
	}),
});

const GHSA = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i;
const MAX_REASON_CHARS = 300;

const unavailable = (reason: string): ParsedAudit => ({
	status: "unavailable",
	reason: reason.slice(0, MAX_REASON_CHARS),
});

const jsonSlice = (text: string): string | undefined => {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	return start >= 0 && end > start ? text.slice(start, end + 1) : undefined;
};

const advisoryId = (via: z.infer<typeof ViaObject>, fallback: string): string => {
	const ghsa = via.url === undefined ? null : GHSA.exec(via.url);
	if (ghsa) return `GHSA-${ghsa[0].slice("GHSA-".length).toLowerCase()}`;
	return `npm:${via.source ?? fallback}`;
};

const toAdvisories = (report: z.infer<typeof AuditReport>): Advisory[] => {
	const seen = new Map<string, Advisory>();
	for (const entry of Object.values(report.vulnerabilities)) {
		const fixAvailable = entry.fixAvailable !== undefined && entry.fixAvailable !== false;
		for (const via of entry.via) {
			if (typeof via === "string") continue;
			const pkg = via.name ?? entry.name;
			const advisory: Advisory = {
				id: advisoryId(via, pkg),
				package: pkg,
				severity: via.severity ?? entry.severity,
				fixAvailable,
			};
			seen.set(`${advisory.id}|${advisory.package}`, advisory);
		}
	}
	return [...seen.values()];
};

export const parseNpmAudit = (text: string): ParsedAudit => {
	const slice = jsonSlice(text);
	if (slice === undefined) return unavailable("npm audit produced no JSON output");
	let raw: unknown;
	try {
		raw = JSON.parse(slice);
	} catch {
		return unavailable("npm audit output is not valid JSON");
	}
	const failure = ErrorReport.safeParse(raw);
	if (failure.success) {
		const { code, summary } = failure.data.error;
		return unavailable(`npm audit failed: ${[code, summary].filter(Boolean).join(" ")}`);
	}
	const report = AuditReport.safeParse(raw);
	if (!report.success) return unavailable("npm audit output has an unexpected shape");
	return { status: "parsed", advisories: toAdvisories(report.data) };
};
