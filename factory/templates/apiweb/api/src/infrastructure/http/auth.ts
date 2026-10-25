import type { RequestHandler, Response } from "express";
import { forbidden, unauthorized } from "../errors.js";

import type { AuthContext } from "../security/authContext.js";

export type { AuthContext };

export type Authenticate = (accessToken: string) => Promise<AuthContext | null>;

const BEARER = /^Bearer ([A-Za-z0-9_-]{20,200})$/;

export const getAuth = (res: Response): AuthContext => {
	const auth: unknown = res.locals.auth;
	if (typeof auth !== "object" || auth === null) throw unauthorized();
	return auth as AuthContext;
};

export const createRequireAuth =
	(authenticate: Authenticate): RequestHandler =>
	async (req, res, next) => {
		try {
			const match = BEARER.exec(req.header("authorization") ?? "");
			const context = match?.[1] === undefined ? null : await authenticate(match[1]);
			if (context === null) {
				res.setHeader("www-authenticate", "Bearer");
				next(unauthorized());
				return;
			}
			res.locals.auth = context;
			next();
		} catch (error) {
			next(error);
		}
	};

export const requireRole =
	(...roles: readonly string[]): RequestHandler =>
	(_req, res, next) => {
		try {
			next(roles.includes(getAuth(res).role) ? undefined : forbidden());
		} catch (error) {
			next(error);
		}
	};
