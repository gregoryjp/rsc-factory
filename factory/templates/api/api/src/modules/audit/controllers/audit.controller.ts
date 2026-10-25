import type { RequestHandler } from "express";
import { getAuth } from "../../../infrastructure/http/auth.js";
import { sendPage } from "../../../infrastructure/http/respond.js";
import { parsePageQuery } from "../../../infrastructure/pagination.js";
import type { AuditService } from "../services/audit.service.js";

export type AuditController = { list: RequestHandler };

export const createAuditController = (service: AuditService): AuditController => ({
	list: async (req, res) => {
		const query = parsePageQuery(req.query);
		sendPage(res, await service.listForActor(getAuth(res).userId, query));
	},
});
