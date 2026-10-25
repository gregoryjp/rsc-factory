import { Prisma, type PrismaClient } from "@prisma/client";
import type { IdempotencyRecord } from "../types/idempotency.types.js";

export type IdempotencyRepository = ReturnType<typeof createIdempotencyRepository>;

const toJson = (body: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull =>
	body === null || body === undefined ? Prisma.DbNull : (body as Prisma.InputJsonValue);

export const createIdempotencyRepository = (prisma: PrismaClient) => ({
	find: async (userId: string, key: string): Promise<IdempotencyRecord | null> => {
		const row = await prisma.idempotencyKey.findUnique({ where: { userId_key: { userId, key } } });
		return row === null
			? null
			: {
					id: row.id,
					requestHash: row.requestHash,
					responseStatus: row.responseStatus,
					responseBody: row.responseBody,
					expiresAt: row.expiresAt,
				};
	},
	create: async (data: {
		userId: string;
		key: string;
		requestHash: string;
		expiresAt: Date;
	}): Promise<boolean> => {
		try {
			await prisma.idempotencyKey.create({ data });
			return true;
		} catch (error) {
			if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
				return false;
			}
			throw error;
		}
	},
	complete: async (userId: string, key: string, status: number, body: unknown): Promise<void> => {
		await prisma.idempotencyKey.updateMany({
			where: { userId, key, responseStatus: null },
			data: { responseStatus: status, responseBody: toJson(body) },
		});
	},
	remove: async (userId: string, key: string): Promise<void> => {
		await prisma.idempotencyKey.deleteMany({ where: { userId, key } });
	},
	removeExpired: async (now: Date): Promise<number> => {
		const result = await prisma.idempotencyKey.deleteMany({ where: { expiresAt: { lte: now } } });
		return result.count;
	},
});
