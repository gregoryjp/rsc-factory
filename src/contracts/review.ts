import { z } from "zod";

const NonEmpty = z.string().min(1);

export const ReviewAreaSchema = z.enum(["security", "code", "ux", "ui"]);
export type ReviewArea = z.infer<typeof ReviewAreaSchema>;

export const SeveritySchema = z.enum(["critical", "high", "medium", "low"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const ConfidenceSchema = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const VerdictSchema = z.enum(["pass", "findings", "blocked", "not_applicable"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const FindingSchema = z.strictObject({
	id: NonEmpty,
	severity: SeveritySchema,
	confidence: ConfidenceSchema,
	title: NonEmpty,
	file: NonEmpty.optional(),
	lineStart: z.number().int().positive().optional(),
	lineEnd: z.number().int().positive().optional(),
	evidence: NonEmpty,
	impact: NonEmpty,
	recommendation: NonEmpty,
	requirementIds: z.array(NonEmpty).optional(),
	evidenceRef: NonEmpty.optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const AckSchema = z.strictObject({
	path: NonEmpty,
	decision: z.enum(["ok", "finding"]),
	note: z.string(),
});
export type Ack = z.infer<typeof AckSchema>;

export const ReviewerOutputSchema = z.strictObject({
	area: ReviewAreaSchema,
	verdict: VerdictSchema,
	reason: z.string().optional(),
	findings: z.array(FindingSchema),
	requiresReviewAck: z.array(AckSchema),
});
export type ReviewerOutput = z.infer<typeof ReviewerOutputSchema>;

export const RefuterOutputSchema = z.strictObject({
	outcomes: z.array(
		z.strictObject({
			id: NonEmpty,
			outcome: z.enum(["confirmed", "refuted", "uncertain"]),
			evidence: NonEmpty,
		}),
	),
});
export type RefuterOutput = z.infer<typeof RefuterOutputSchema>;
export type RefutationOutcome = RefuterOutput["outcomes"][number]["outcome"];

export const ApproverOutputSchema = z.strictObject({
	recommendation: z.enum(["accept", "repair", "block"]),
	repairTasks: z.array(
		z.strictObject({ findingIds: z.array(NonEmpty).min(1), instruction: NonEmpty }),
	),
	notes: z.string(),
});
export type ApproverOutput = z.infer<typeof ApproverOutputSchema>;
export type ApproverRecommendation = ApproverOutput["recommendation"];
