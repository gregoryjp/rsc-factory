import type { AuditRecorder } from "../../../infrastructure/audit.js";
import type { Logger } from "../../../infrastructure/logger.js";
import {
	type Page,
	type PageQuery,
	pageWindow,
	toPage,
} from "../../../infrastructure/pagination.js";
import { fail, ok } from "../../../infrastructure/result.js";
import type { AuditRepository } from "../repositories/audit.repository.js";
import { AuditEventSchema } from "../schemas/audit.schemas.js";
import type { AuditEventRecord, PublicAuditEvent } from "../types/audit.types.js";

export type AuditService = ReturnType<typeof createAuditService>;

const toPublicEvent = (event: AuditEventRecord): PublicAuditEvent => ({
	id: event.id,
	action: event.action,
	resource: event.resource,
	ip: event.ip,
	requestId: event.requestId,
	createdAt: event.createdAt.toISOString(),
});

export const createAuditService = (repository: AuditRepository, logger: Pick<Logger, "error">) => {
	const record: AuditRecorder = async (event) => {
		const parsed = AuditEventSchema.safeParse(event);
		if (!parsed.success) return fail("invalid_audit_event");
		try {
			await repository.create(parsed.data);
			return ok(undefined);
		} catch (error) {
			logger.error({ err: error, action: parsed.data.action }, "audit write failed");
			return fail("audit_write_failed");
		}
	};

	const listForActor = async (
		actorId: string,
		query: PageQuery,
	): Promise<Page<PublicAuditEvent>> => {
		const rows = await repository.findByActor(actorId, pageWindow(query));
		const page = toPage(rows, query);
		return { items: page.items.map(toPublicEvent), page: page.page };
	};

	return { record, listForActor };
};
