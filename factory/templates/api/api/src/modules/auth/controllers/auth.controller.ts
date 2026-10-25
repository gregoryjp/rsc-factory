import type { CookieOptions, RequestHandler } from "express";
import { unauthorized } from "../../../infrastructure/errors.js";
import { getAuth } from "../../../infrastructure/http/auth.js";
import { requestContextOf } from "../../../infrastructure/http/requestContext.js";
import { sendData } from "../../../infrastructure/http/respond.js";
import { loginSchema, registerSchema } from "../schemas/auth.schemas.js";
import { type AuthService, REFRESH_TOKEN_TTL_MS } from "../services/auth.service.js";

export const REFRESH_COOKIE_NAME = "refresh_token";
export const REFRESH_COOKIE_PATH = "/api/v1/auth";

export type AuthController = {
	register: RequestHandler;
	login: RequestHandler;
	refresh: RequestHandler;
	logout: RequestHandler;
	me: RequestHandler;
};

const readCookie = (header: string | undefined, name: string): string | undefined => {
	if (header === undefined) return undefined;
	for (const part of header.split(";")) {
		const separator = part.indexOf("=");
		if (separator !== -1 && part.slice(0, separator).trim() === name) {
			return part.slice(separator + 1).trim();
		}
	}
	return undefined;
};

export const createAuthController = (
	service: AuthService,
	options: { secureCookies: boolean },
): AuthController => {
	const cookieOptions: CookieOptions = {
		httpOnly: true,
		secure: options.secureCookies,
		sameSite: "strict",
		path: REFRESH_COOKIE_PATH,
	};

	return {
		register: async (req, res) => {
			const user = await service.register(
				registerSchema.parse(req.body),
				requestContextOf(req, res),
			);
			sendData(res, { user }, 201);
		},
		login: async (req, res) => {
			const { user, tokens } = await service.login(
				loginSchema.parse(req.body),
				requestContextOf(req, res),
			);
			res.cookie(REFRESH_COOKIE_NAME, tokens.refreshToken, {
				...cookieOptions,
				maxAge: REFRESH_TOKEN_TTL_MS,
			});
			res.setHeader("cache-control", "no-store");
			sendData(res, {
				user,
				accessToken: tokens.accessToken,
				accessExpiresAt: tokens.accessExpiresAt.toISOString(),
			});
		},
		refresh: async (req, res) => {
			const token = readCookie(req.header("cookie"), REFRESH_COOKIE_NAME);
			if (token === undefined || token.length === 0) throw unauthorized("Invalid refresh token");
			const tokens = await service.refresh(token, requestContextOf(req, res));
			res.cookie(REFRESH_COOKIE_NAME, tokens.refreshToken, {
				...cookieOptions,
				maxAge: REFRESH_TOKEN_TTL_MS,
			});
			res.setHeader("cache-control", "no-store");
			sendData(res, {
				accessToken: tokens.accessToken,
				accessExpiresAt: tokens.accessExpiresAt.toISOString(),
			});
		},
		logout: async (req, res) => {
			await service.logout(
				readCookie(req.header("cookie"), REFRESH_COOKIE_NAME),
				requestContextOf(req, res),
			);
			res.clearCookie(REFRESH_COOKIE_NAME, cookieOptions);
			res.status(204).end();
		},
		me: async (_req, res) => {
			sendData(res, { user: await service.me(getAuth(res).userId) });
		},
	};
};
