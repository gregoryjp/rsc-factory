import { Prisma, type PrismaClient } from "@prisma/client";
import type { NewSession, SessionRecord, UserRecord } from "../types/auth.types.js";

export type AuthRepository = ReturnType<typeof createAuthRepository>;

export const createAuthRepository = (prisma: PrismaClient) => ({
	createUser: async (data: { email: string; passwordHash: string }): Promise<UserRecord | null> => {
		try {
			return await prisma.user.create({ data });
		} catch (error) {
			if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
				return null;
			}
			throw error;
		}
	},
	findUserByEmail: (email: string): Promise<UserRecord | null> =>
		prisma.user.findUnique({ where: { email } }),
	findUserById: (id: string): Promise<UserRecord | null> =>
		prisma.user.findUnique({ where: { id } }),
	createSession: (data: NewSession): Promise<SessionRecord> => prisma.session.create({ data }),
	findSessionByAccessHash: (accessTokenHash: string): Promise<SessionRecord | null> =>
		prisma.session.findUnique({ where: { accessTokenHash } }),
	findSessionByRefreshHash: (refreshTokenHash: string): Promise<SessionRecord | null> =>
		prisma.session.findUnique({ where: { refreshTokenHash } }),
	markRotated: async (id: string, now: Date): Promise<boolean> => {
		const result = await prisma.session.updateMany({
			where: { id, rotatedAt: null, revokedAt: null },
			data: { rotatedAt: now },
		});
		return result.count === 1;
	},
	revokeFamily: async (familyId: string, now: Date): Promise<void> => {
		await prisma.session.updateMany({
			where: { familyId, revokedAt: null },
			data: { revokedAt: now },
		});
	},
});
