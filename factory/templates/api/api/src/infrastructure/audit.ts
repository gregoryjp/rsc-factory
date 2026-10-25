import type { Result } from "./result.js";

export type AuditEventInput = {
	action: string;
	actorId?: string | null;
	resource?: string | null;
	ip?: string | null;
	requestId?: string | null;
};

export type AuditFailure = "invalid_audit_event" | "audit_write_failed";

export type AuditRecorder = (event: AuditEventInput) => Promise<Result<void, AuditFailure>>;

export type RequestContext = { ip: string | null; requestId: string };
