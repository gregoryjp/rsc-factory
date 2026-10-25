import type { PrismaClient } from "@prisma/client";
import type { Router } from "express";
import type { AuditRecorder } from "../../infrastructure/audit.js";
import type { Logger } from "../../infrastructure/logger.js";
import { createAuditController } from "./controllers/audit.controller.js";
import { createAuditRepository } from "./repositories/audit.repository.js";
import { createAuditRoutes } from "./routes/audit.routes.js";
import { createAuditService } from "./services/audit.service.js";

export type AuditModule = { router: Router; record: AuditRecorder };

export const createAuditModule = (deps: {
	prisma: PrismaClient;
	logger: Pick<Logger, "error">;
}): AuditModule => {
	const service = createAuditService(createAuditRepository(deps.prisma), deps.logger);
	return { router: createAuditRoutes(createAuditController(service)), record: service.record };
};
