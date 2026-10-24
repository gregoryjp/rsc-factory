import { env } from "./config/env.js";
import { prisma } from "./infrastructure/database.js";
import { createApp } from "./infrastructure/http/app.js";
import { logger } from "./infrastructure/logger.js";
import { createHealthModule } from "./modules/health/index.js";

export const createProductApp = () =>
	createApp({
		logger,
		corsOrigins: env.CORS_ORIGINS,
		mounts: [{ path: "/health", router: createHealthModule({ prisma }) }],
	});
