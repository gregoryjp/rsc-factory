import { buildProduct } from "./composition.js";
import { env } from "./config/env.js";
import { prisma } from "./infrastructure/database.js";
import { configureServerTimeouts } from "./infrastructure/http/serverTimeouts.js";
import { logger } from "./infrastructure/logger.js";
import { createShutdown } from "./infrastructure/shutdown.js";

const PURGE_INTERVAL_MS = 60 * 60 * 1000;

const { app, lifecycle, idempotency } = buildProduct();

const server = app.listen(env.PORT, () => {
	logger.info({ port: env.PORT }, "server listening");
});

configureServerTimeouts(server, { requestTimeoutMs: env.REQUEST_TIMEOUT_MS });

const purge = setInterval(() => {
	idempotency.purgeExpired().catch((error: unknown) => {
		logger.error({ err: error }, "idempotency purge failed");
	});
}, PURGE_INTERVAL_MS);
purge.unref();

const shutdown = createShutdown({
	server,
	lifecycle,
	closeResources: async () => {
		clearInterval(purge);
		await prisma.$disconnect();
	},
	logger,
	timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
	exit: (code) => process.exit(code),
});

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
