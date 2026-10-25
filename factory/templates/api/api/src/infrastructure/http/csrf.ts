import type { RequestHandler } from "express";
import { forbidden } from "../errors.js";

export const CSRF_HEADER = "x-requested-with";
export const CSRF_HEADER_VALUE = "factory";

export const createCsrfProtection =
	(allowedOrigins: readonly string[]): RequestHandler =>
	(req, _res, next) => {
		if (req.header(CSRF_HEADER) !== CSRF_HEADER_VALUE) {
			next(forbidden("Missing required request header"));
			return;
		}
		const origin = req.header("origin");
		if (origin !== undefined && !allowedOrigins.includes(origin)) {
			next(forbidden("Origin not allowed"));
			return;
		}
		next();
	};
