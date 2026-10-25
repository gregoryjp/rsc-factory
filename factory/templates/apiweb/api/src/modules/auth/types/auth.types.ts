export type UserRecord = {
	id: string;
	email: string;
	passwordHash: string;
	role: string;
	createdAt: Date;
	disabledAt: Date | null;
};

export type SessionRecord = {
	id: string;
	familyId: string;
	userId: string;
	accessTokenHash: string;
	refreshTokenHash: string;
	accessExpiresAt: Date;
	refreshExpiresAt: Date;
	rotatedAt: Date | null;
	revokedAt: Date | null;
};

export type NewSession = Omit<SessionRecord, "id" | "rotatedAt" | "revokedAt">;

export type PublicUser = { id: string; email: string; role: string };

export type IssuedTokens = {
	accessToken: string;
	refreshToken: string;
	accessExpiresAt: Date;
	refreshExpiresAt: Date;
};

export type LoginResult = { user: PublicUser; tokens: IssuedTokens };
