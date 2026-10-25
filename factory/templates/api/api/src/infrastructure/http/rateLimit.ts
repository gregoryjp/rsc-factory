import type { RequestHandler } from "express";
import { rateLimit, type Store } from "express-rate-limit";
import { sendError } from "./respond.js";

export type RateLimitConfig = {
	windowMs: number;
	max: number;
	authMax: number;
	createStore?: () => Store;
};

export type RateLimiters = { global: RequestHandler; auth: RequestHandler };

const build = (
	config: RateLimitConfig,
	limit: number,
	skip?: (path: string) => boolean,
): RequestHandler =>
	rateLimit({
		windowMs: config.windowMs,
		limit,
		standardHeaders: "draft-7",
		legacyHeaders: false,
		store: config.createStore?.(),
		skip: (req) => skip?.(req.path) === true,
		handler: (_req, res) => {
			sendError(res, 429, { code: "RATE_LIMITED", message: "Too many requests" });
		},
	});

export const createRateLimiters = (config: RateLimitConfig): RateLimiters => ({
	global: build(config, config.max, (path) => path.startsWith("/health")),
	auth: build(config, config.authMax),
});
