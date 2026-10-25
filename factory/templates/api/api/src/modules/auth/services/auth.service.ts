import { randomUUID } from "node:crypto";
import { conflict, unauthorized } from "../../../infrastructure/errors.js";
import type { AuthContext } from "../../../infrastructure/security/authContext.js";
import { hashPassword, verifyPassword } from "../../../infrastructure/security/password.js";
import { generateToken, hashToken } from "../../../infrastructure/security/tokens.js";
import type { AuthRepository } from "../repositories/auth.repository.js";
import type { LoginInput, RegisterInput } from "../schemas/auth.schemas.js";
import type { IssuedTokens, LoginResult, PublicUser, UserRecord } from "../types/auth.types.js";

export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type AuthService = ReturnType<typeof createAuthService>;

const toPublicUser = (user: UserRecord): PublicUser => ({
	id: user.id,
	email: user.email,
	role: user.role,
});

export const createAuthService = (
	repository: AuthRepository,
	now: () => Date = () => new Date(),
) => {
	const dummyHash = hashPassword(generateToken());

	const issueSession = async (userId: string, familyId: string): Promise<IssuedTokens> => {
		const accessToken = generateToken();
		const refreshToken = generateToken();
		const issuedAt = now();
		const accessExpiresAt = new Date(issuedAt.getTime() + ACCESS_TOKEN_TTL_MS);
		const refreshExpiresAt = new Date(issuedAt.getTime() + REFRESH_TOKEN_TTL_MS);
		await repository.createSession({
			familyId,
			userId,
			accessTokenHash: hashToken(accessToken),
			refreshTokenHash: hashToken(refreshToken),
			accessExpiresAt,
			refreshExpiresAt,
		});
		return { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt };
	};

	const register = async (input: RegisterInput): Promise<PublicUser> => {
		const passwordHash = await hashPassword(input.password);
		const user = await repository.createUser({ email: input.email, passwordHash });
		if (user === null) throw conflict("Registration could not be completed");
		return toPublicUser(user);
	};

	const login = async (input: LoginInput): Promise<LoginResult> => {
		const user = await repository.findUserByEmail(input.email);
		const passwordMatches = await verifyPassword(
			user?.passwordHash ?? (await dummyHash),
			input.password,
		);
		if (user === null || !passwordMatches || user.disabledAt !== null) {
			throw unauthorized("Invalid credentials");
		}
		return { user: toPublicUser(user), tokens: await issueSession(user.id, randomUUID()) };
	};

	const refresh = async (refreshToken: string): Promise<IssuedTokens> => {
		const session = await repository.findSessionByRefreshHash(hashToken(refreshToken));
		if (session === null) throw unauthorized("Invalid refresh token");
		const current = now();
		if (session.rotatedAt !== null || session.revokedAt !== null) {
			await repository.revokeFamily(session.familyId, current);
			throw unauthorized("Invalid refresh token");
		}
		if (session.refreshExpiresAt <= current) throw unauthorized("Invalid refresh token");
		const user = await repository.findUserById(session.userId);
		if (user === null || user.disabledAt !== null) {
			await repository.revokeFamily(session.familyId, current);
			throw unauthorized("Invalid refresh token");
		}
		if (!(await repository.markRotated(session.id, current))) {
			await repository.revokeFamily(session.familyId, current);
			throw unauthorized("Invalid refresh token");
		}
		return issueSession(session.userId, session.familyId);
	};

	const logout = async (refreshToken: string | undefined): Promise<void> => {
		if (refreshToken === undefined) return;
		const session = await repository.findSessionByRefreshHash(hashToken(refreshToken));
		if (session !== null) await repository.revokeFamily(session.familyId, now());
	};

	const authenticate = async (accessToken: string): Promise<AuthContext | null> => {
		const session = await repository.findSessionByAccessHash(hashToken(accessToken));
		if (session === null || session.rotatedAt !== null || session.revokedAt !== null) return null;
		if (session.accessExpiresAt <= now()) return null;
		const user = await repository.findUserById(session.userId);
		if (user === null || user.disabledAt !== null) return null;
		return { userId: user.id, role: user.role, sessionId: session.id };
	};

	const me = async (userId: string): Promise<PublicUser> => {
		const user = await repository.findUserById(userId);
		if (user === null || user.disabledAt !== null) throw unauthorized();
		return toPublicUser(user);
	};

	return { register, login, refresh, logout, authenticate, me };
};
