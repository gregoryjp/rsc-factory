import type { PrismaClient } from "@prisma/client";
import type { Router } from "express";
import type { Lifecycle } from "../../infrastructure/lifecycle.js";
import { createHealthController } from "./controllers/health.controller.js";
import { createHealthRepository } from "./repositories/health.repository.js";
import { createHealthRoutes } from "./routes/health.routes.js";
import { createHealthService } from "./services/health.service.js";

export const createHealthModule = (deps: { prisma: PrismaClient; lifecycle: Lifecycle }): Router =>
	createHealthRoutes(
		createHealthController(
			createHealthService(createHealthRepository(deps.prisma), deps.lifecycle),
		),
	);
