import { z } from "zod";
import { countBySeverity, type SeverityCounts } from "./evaluate.js";

export type AdvisoryRef = { id: string; package: string; severity: string };

export type AuditSummaryEntry = {
	phase: string;
	status: string;
	counts: SeverityCounts | null;
	newSevere: AdvisoryRef[];
	acceptedBaseline: AdvisoryRef[];
	reason: string | null;
};

export type AuditSummary = {
	entries: AuditSummaryEntry[];
	blockingNew: number;
	unavailable: boolean;
};

export type AuditEventLike = { type: string; payload: Record<string, unknown> };

const Ref = z.object({ id: z.string(), package: z.string(), severity: z.string() });
const Counts = z.object({
	info: z.number(),
	low: z.number(),
	moderate: z.number(),
	high: z.number(),
	critical: z.number(),
});

const refs = (value: unknown): AdvisoryRef[] => {
	const parsed = z.array(Ref).safeParse(value);
	return parsed.success ? parsed.data : [];
};

const entryOf = (payload: Record<string, unknown>): AuditSummaryEntry => {
	const counts = Counts.safeParse(payload.counts);
	return {
		phase: typeof payload.phase === "string" ? payload.phase : "unknown",
		status: typeof payload.status === "string" ? payload.status : "unknown",
		counts: counts.success ? counts.data : countBySeverity([]),
		newSevere: refs(payload.newSevere),
		acceptedBaseline: refs(payload.acceptedBaseline),
		reason: typeof payload.reason === "string" ? payload.reason : null,
	};
};

export const summarizeAudit = (events: readonly AuditEventLike[]): AuditSummary => {
	const entries = events
		.filter((e) => e.type === "depaudit.recorded")
		.map((e) => entryOf(e.payload));
	const last = entries.findLast((entry) => entry.phase !== "baseline");
	return {
		entries,
		blockingNew: last?.status === "new_vulnerability" ? last.newSevere.length : 0,
		unavailable: last?.status === "unavailable",
	};
};
