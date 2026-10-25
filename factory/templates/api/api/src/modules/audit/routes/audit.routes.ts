import { Router } from "express";
import type { AuditController } from "../controllers/audit.controller.js";

export const createAuditRoutes = (controller: AuditController): Router =>
	Router().get("/events", controller.list);
