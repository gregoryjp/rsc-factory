import { Router } from "express";
import type { HealthController } from "../controllers/health.controller.js";

export const createHealthRoutes = (controller: HealthController): Router =>
	Router().get("/live", controller.live).get("/ready", controller.ready);
