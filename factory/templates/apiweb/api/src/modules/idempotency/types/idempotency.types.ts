export type IdempotencyRecord = {
	id: string;
	requestHash: string;
	responseStatus: number | null;
	responseBody: unknown;
	expiresAt: Date;
};

export type BeginOutcome =
	| { kind: "proceed" }
	| { kind: "replay"; status: number; body: unknown }
	| { kind: "mismatch" }
	| { kind: "in_progress" };
