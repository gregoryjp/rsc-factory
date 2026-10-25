import type { PrismaClient } from "@prisma/client";
import type { RequestHandler } from "express";
import type { Logger } from "../../infrastructure/logger.js";
import { createIdempotencyMiddleware } from "./middleware/idempotency.middleware.js";
import { createIdempotencyRepository } from "./repositories/idempotency.repository.js";
import { createIdempotencyService } from "./services/idempotency.service.js";

export type IdempotencyModule = {
	middleware: RequestHandler;
	purgeExpired: () => Promise<number>;
};

export const createIdempotencyModule = (deps: {
	prisma: PrismaClient;
	logger: Pick<Logger, "error">;
	ttlMs: number;
	now?: () => Date;
}): IdempotencyModule => {
	const service = createIdempotencyService(createIdempotencyRepository(deps.prisma), {
		ttlMs: deps.ttlMs,
		now: deps.now,
	});
	return {
		middleware: createIdempotencyMiddleware(service, deps.logger),
		purgeExpired: service.purgeExpired,
	};
};
