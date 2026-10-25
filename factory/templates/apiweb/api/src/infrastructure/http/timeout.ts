import type { RequestHandler } from "express";
import { sendError } from "./respond.js";

export const createTimeoutMiddleware =
	(timeoutMs: number): RequestHandler =>
	(_req, res, next) => {
		const timer = setTimeout(() => {
			if (res.headersSent) return;
			sendError(res, 503, { code: "REQUEST_TIMEOUT", message: "Request timed out" });
		}, timeoutMs);
		const clear = (): void => clearTimeout(timer);
		res.once("finish", clear);
		res.once("close", clear);
		next();
	};
