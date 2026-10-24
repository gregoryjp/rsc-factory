import { z } from "zod";

export const AgentResultSchema = z.discriminatedUnion("status", [
	z.strictObject({
		status: z.literal("completed"),
		artifactIds: z.array(z.string()),
		evidenceIds: z.array(z.string()),
	}),
	z.strictObject({
		status: z.literal("blocked"),
		reason: z.string(),
		requiredInputs: z.array(z.string()),
	}),
	z.strictObject({
		status: z.literal("failed"),
		errorCode: z.string(),
		retryable: z.boolean(),
	}),
]);
export type AgentResult = z.infer<typeof AgentResultSchema>;
