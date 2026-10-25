import { z } from "zod";
import { countSastBySeverity, type SastCounts } from "./evaluate.js";

export type SastRef = { rule: string; file: string; severity: string };

export type SastSummaryEntry = {
	phase: string;
	status: string;
	counts: SastCounts | null;
	newSevere: SastRef[];
	acceptedBaseline: SastRef[];
	reason: string | null;
};

export type SastSummary = {
	entries: SastSummaryEntry[];
	blockingNew: number;
	unavailable: boolean;
};

export type SastEventLike = { type: string; payload: Record<string, unknown> };

const Ref = z.object({ rule: z.string(), file: z.string(), severity: z.string() });
const Counts = z.object({ low: z.number(), medium: z.number(), high: z.number() });

const refs = (value: unknown): SastRef[] => {
	const parsed = z.array(Ref).safeParse(value);
	return parsed.success ? parsed.data : [];
};

const entryOf = (payload: Record<string, unknown>): SastSummaryEntry => {
	const counts = Counts.safeParse(payload.counts);
	return {
		phase: typeof payload.phase === "string" ? payload.phase : "unknown",
		status: typeof payload.status === "string" ? payload.status : "unknown",
		counts: counts.success ? counts.data : countSastBySeverity([]),
		newSevere: refs(payload.newSevere),
		acceptedBaseline: refs(payload.acceptedBaseline),
		reason: typeof payload.reason === "string" ? payload.reason : null,
	};
};

export const summarizeSast = (events: readonly SastEventLike[]): SastSummary => {
	const entries = events.filter((e) => e.type === "sast.recorded").map((e) => entryOf(e.payload));
	const last = entries.findLast((entry) => entry.phase !== "baseline");
	return {
		entries,
		blockingNew: last?.status === "new_finding" ? last.newSevere.length : 0,
		unavailable: last?.status === "unavailable",
	};
};
