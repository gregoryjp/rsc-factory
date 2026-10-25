import type { PrismaClient } from "@prisma/client";
import type { ValidAuditEvent } from "../schemas/audit.schemas.js";
import type { AuditEventRecord } from "../types/audit.types.js";

export type AuditRepository = ReturnType<typeof createAuditRepository>;

export const createAuditRepository = (prisma: PrismaClient) => ({
	create: async (event: ValidAuditEvent): Promise<void> => {
		await prisma.auditEvent.create({ data: event });
	},
	findByActor: (
		actorId: string,
		window: { take: number; skip: number },
	): Promise<AuditEventRecord[]> =>
		prisma.auditEvent.findMany({
			where: { actorId },
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			take: window.take,
			skip: window.skip,
		}),
});
