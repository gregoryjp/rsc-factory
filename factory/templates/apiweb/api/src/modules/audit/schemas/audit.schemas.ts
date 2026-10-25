import { z } from "zod";

export const AuditEventSchema = z.object({
	action: z
		.string()
		.max(64)
		.regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
	actorId: z.string().max(64).nullish(),
	resource: z.string().max(128).nullish(),
	ip: z.string().max(64).nullish(),
	requestId: z.string().max(64).nullish(),
});

export type ValidAuditEvent = z.infer<typeof AuditEventSchema>;
