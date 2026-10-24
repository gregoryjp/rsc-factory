import { Prisma } from "@prisma/client";
import cors from "cors";
import express, {
	type ErrorRequestHandler,
	type Express,
	type RequestHandler,
	type Router,
} from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { ZodError } from "zod";
import { isAppError } from "../errors.js";
import type { Logger } from "../logger.js";
import { requestIdMiddleware } from "../requestId.js";
import { sendError } from "./respond.js";

export type RouteMount = { path: string; router: Router };

export type AppOptions = {
	logger: Logger;
	corsOrigins: readonly string[];
	mounts: readonly RouteMount[];
};

export const notFoundHandler: RequestHandler = (_req, res) => {
	sendError(res, 404, { code: "NOT_FOUND", message: "Route not found" });
};

const bodyErrorType = (error: unknown): string | undefined =>
	typeof error === "object" && error !== null && "type" in error
		? String((error as { type: unknown }).type)
		: undefined;

export const createErrorHandler =
	(logger: Logger): ErrorRequestHandler =>
	(error, _req, res, next) => {
		if (res.headersSent) {
			next(error);
			return;
		}
		if (isAppError(error)) {
			sendError(res, error.status, {
				code: error.code,
				message: error.message,
				details: error.details,
			});
			return;
		}
		if (error instanceof ZodError) {
			sendError(res, 400, {
				code: "VALIDATION_ERROR",
				message: "Request validation failed",
				details: error.issues,
			});
			return;
		}
		const bodyType = bodyErrorType(error);
		if (bodyType === "entity.parse.failed") {
			sendError(res, 400, { code: "INVALID_JSON", message: "Request body is not valid JSON" });
			return;
		}
		if (bodyType === "entity.too.large") {
			sendError(res, 413, { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large" });
			return;
		}
		if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
			sendError(res, 404, { code: "NOT_FOUND", message: "Resource not found" });
			return;
		}
		logger.error({ err: error }, "unhandled error");
		sendError(res, 500, { code: "INTERNAL_ERROR", message: "Internal server error" });
	};

export const createApp = (options: AppOptions): Express => {
	const app = express();
	const allowed = new Set(options.corsOrigins);
	app.use(requestIdMiddleware);
	app.use(pinoHttp({ logger: options.logger }));
	app.use(helmet());
	app.use(
		cors({
			origin: (origin, callback) => callback(null, origin === undefined || allowed.has(origin)),
		}),
	);
	app.use(express.json({ limit: "100kb" }));
	for (const mount of options.mounts) app.use(mount.path, mount.router);
	app.use(notFoundHandler);
	app.use(createErrorHandler(options.logger));
	return app;
};
