import type { PrismaClient } from "@prisma/client";

export type HealthRepository = { pingDatabase: () => Promise<void> };

export const createHealthRepository = (client: PrismaClient): HealthRepository => ({
	pingDatabase: async () => {
		await client.$queryRaw`SELECT 1`;
	},
});
