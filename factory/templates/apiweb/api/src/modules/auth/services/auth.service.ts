import { randomUUID } from "node:crypto";
import type {
	AuditEventInput,
	AuditRecorder,
	RequestContext,
} from "../../../infrastructure/audit.js";
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
	audit: AuditRecorder,
	now: () => Date = () => new Date(),
) => {
	const record = (context: RequestContext, event: AuditEventInput) =>
		audit({ ...event, ip: context.ip, requestId: context.requestId });

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

	const register = async (input: RegisterInput, context: RequestContext): Promise<PublicUser> => {
		const passwordHash = await hashPassword(input.password);
		const user = await repository.createUser({ email: input.email, passwordHash });
		if (user === null) throw conflict("Registration could not be completed");
		await record(context, {
			action: "auth.register",
			actorId: user.id,
			resource: `user:${user.id}`,
		});
		return toPublicUser(user);
	};

	const login = async (input: LoginInput, context: RequestContext): Promise<LoginResult> => {
		const user = await repository.findUserByEmail(input.email);
		const passwordMatches = await verifyPassword(
			user?.passwordHash ?? (await dummyHash),
			input.password,
		);
		if (user === null || !passwordMatches || user.disabledAt !== null) {
			await record(context, { action: "auth.login_failed", actorId: user?.id ?? null });
			throw unauthorized("Invalid credentials");
		}
		const tokens = await issueSession(user.id, randomUUID());
		await record(context, { action: "auth.login", actorId: user.id, resource: `user:${user.id}` });
		return { user: toPublicUser(user), tokens };
	};

	const refresh = async (refreshToken: string, context: RequestContext): Promise<IssuedTokens> => {
		const session = await repository.findSessionByRefreshHash(hashToken(refreshToken));
		if (session === null) throw unauthorized("Invalid refresh token");
		const current = now();
		const reuse = (): Promise<unknown> =>
			record(context, {
				action: "auth.refresh_reuse_detected",
				actorId: session.userId,
				resource: `family:${session.familyId}`,
			});
		if (session.rotatedAt !== null || session.revokedAt !== null) {
			await repository.revokeFamily(session.familyId, current);
			await reuse();
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
			await reuse();
			throw unauthorized("Invalid refresh token");
		}
		const tokens = await issueSession(session.userId, session.familyId);
		await record(context, {
			action: "auth.refresh",
			actorId: session.userId,
			resource: `session:${session.id}`,
		});
		return tokens;
	};

	const logout = async (
		refreshToken: string | undefined,
		context: RequestContext,
	): Promise<void> => {
		if (refreshToken === undefined) return;
		const session = await repository.findSessionByRefreshHash(hashToken(refreshToken));
		if (session === null) return;
		await repository.revokeFamily(session.familyId, now());
		await record(context, {
			action: "auth.logout",
			actorId: session.userId,
			resource: `session:${session.id}`,
		});
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
