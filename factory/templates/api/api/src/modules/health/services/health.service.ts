import { serviceUnavailable } from "../../../infrastructure/errors.js";
import type { HealthRepository } from "../repositories/health.repository.js";

export type LiveStatus = { status: "ok" };
export type ReadyStatus = { status: "ok"; checks: { database: "up" } };

export type HealthService = {
	live: () => LiveStatus;
	ready: () => Promise<ReadyStatus>;
};

export const createHealthService = (repository: HealthRepository): HealthService => ({
	live: () => ({ status: "ok" }),
	ready: async () => {
		try {
			await repository.pingDatabase();
		} catch {
			throw serviceUnavailable("Database is not reachable");
		}
		return { status: "ok", checks: { database: "up" } };
	},
});
