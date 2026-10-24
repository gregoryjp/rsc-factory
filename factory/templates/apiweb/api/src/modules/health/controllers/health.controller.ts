import type { RequestHandler } from "express";
import { sendData } from "../../../infrastructure/http/respond.js";
import type { HealthService } from "../services/health.service.js";

export type HealthController = { live: RequestHandler; ready: RequestHandler };

export const createHealthController = (service: HealthService): HealthController => ({
	live: (_req, res) => {
		sendData(res, service.live());
	},
	ready: async (_req, res) => {
		sendData(res, await service.ready());
	},
});
