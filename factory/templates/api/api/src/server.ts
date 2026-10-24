import { createProductApp } from "./composition.js";
import { env } from "./config/env.js";
import { prisma } from "./infrastructure/database.js";
import { logger } from "./infrastructure/logger.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

const server = createProductApp().listen(env.PORT, () => {
	logger.info({ port: env.PORT }, "server listening");
});

let shuttingDown = false;

const shutdown = (signal: string): void => {
	if (shuttingDown) return;
	shuttingDown = true;
	logger.info({ signal }, "shutting down");
	const forced = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS);
	forced.unref();
	server.close(() => {
		prisma
			.$disconnect()
			.then(() => process.exit(0))
			.catch(() => process.exit(1));
	});
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
