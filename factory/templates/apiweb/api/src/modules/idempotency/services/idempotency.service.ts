import { createHash } from "node:crypto";
import type { IdempotencyRepository } from "../repositories/idempotency.repository.js";
import type { BeginOutcome, IdempotencyRecord } from "../types/idempotency.types.js";

export type IdempotencyService = ReturnType<typeof createIdempotencyService>;

const canonicalize = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (typeof value === "object" && value !== null) {
		const source = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(source)
				.sort()
				.map((key) => [key, canonicalize(source[key])]),
		);
	}
	return value;
};

export const fingerprintRequest = (method: string, url: string, body: unknown): string =>
	createHash("sha256")
		.update(`${method.toUpperCase()} ${url}\n${JSON.stringify(canonicalize(body ?? null))}`)
		.digest("hex");

const classify = (record: IdempotencyRecord, requestHash: string): BeginOutcome => {
	if (record.requestHash !== requestHash) return { kind: "mismatch" };
	if (record.responseStatus === null) return { kind: "in_progress" };
	return { kind: "replay", status: record.responseStatus, body: record.responseBody };
};

export const createIdempotencyService = (
	repository: IdempotencyRepository,
	options: { ttlMs: number; now?: () => Date },
) => {
	const now = options.now ?? (() => new Date());

	const begin = async (userId: string, key: string, requestHash: string): Promise<BeginOutcome> => {
		const existing = await repository.find(userId, key);
		if (existing !== null && existing.expiresAt > now()) return classify(existing, requestHash);
		if (existing !== null) await repository.remove(userId, key);
		const created = await repository.create({
			userId,
			key,
			requestHash,
			expiresAt: new Date(now().getTime() + options.ttlMs),
		});
		if (created) return { kind: "proceed" };
		const winner = await repository.find(userId, key);
		return winner === null ? { kind: "in_progress" } : classify(winner, requestHash);
	};

	const finish = async (
		userId: string,
		key: string,
		status: number,
		body: unknown,
	): Promise<void> => {
		if (status >= 500) await repository.remove(userId, key);
		else await repository.complete(userId, key, status, body);
	};

	const abandon = (userId: string, key: string): Promise<void> => repository.remove(userId, key);

	const purgeExpired = (): Promise<number> => repository.removeExpired(now());

	return { begin, finish, abandon, purgeExpired };
};
