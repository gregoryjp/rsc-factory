import { serviceUnavailable } from "../../../infrastructure/errors.js";
import type { Lifecycle } from "../../../infrastructure/lifecycle.js";
import type { HealthRepository } from "../repositories/health.repository.js";

const READINESS_TIMEOUT_MS = 2_000;

export type LiveStatus = { status: "ok" };
export type ReadyStatus = { status: "ok"; checks: { database: "up" } };

const withTimeout = (promise: Promise<void>, timeoutMs: number): Promise<void> =>
	new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
		promise.then(resolve, reject).finally(() => clearTimeout(timer));
	});

export type HealthService = {
	live: () => LiveStatus;
	ready: () => Promise<ReadyStatus>;
};

export const createHealthService = (
	repository: HealthRepository,
	lifecycle: Lifecycle,
): HealthService => ({
	live: () => ({ status: "ok" }),
	ready: async () => {
		if (lifecycle.isShuttingDown()) throw serviceUnavailable("Shutting down");
		try {
			await withTimeout(repository.pingDatabase(), READINESS_TIMEOUT_MS);
		} catch {
			throw serviceUnavailable("Database is not reachable");
		}
		return { status: "ok", checks: { database: "up" } };
	},
});
