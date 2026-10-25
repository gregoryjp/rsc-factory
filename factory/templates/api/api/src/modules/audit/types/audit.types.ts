export type AuditEventRecord = {
	id: string;
	actorId: string | null;
	action: string;
	resource: string | null;
	ip: string | null;
	requestId: string | null;
	createdAt: Date;
};

export type PublicAuditEvent = {
	id: string;
	action: string;
	resource: string | null;
	ip: string | null;
	requestId: string | null;
	createdAt: string;
};
