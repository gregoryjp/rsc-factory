import { type RequestHandler, Router } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildTestProduct, credentials } from "../../../../test/helpers.js";
import { prisma } from "../../../infrastructure/database.js";
import { sendData } from "../../../infrastructure/http/respond.js";
import { logger } from "../../../infrastructure/logger.js";
import { createIdempotencyModule } from "../index.js";

type HarnessOptions = {
	ttlMs?: number;
	now?: () => Date;
	slowMs?: number;
	fail?: boolean;
};

const harness = (options: HarnessOptions = {}) => {
	let count = 0;
	const idempotency = createIdempotencyModule({
		prisma,
		logger,
		ttlMs: options.ttlMs ?? 60_000,
		now: options.now,
	});
	const create: RequestHandler = async (req, res) => {
		count += 1;
		if (options.slowMs !== undefined) {
			await new Promise((resolve) => setTimeout(resolve, options.slowMs));
		}
		if (options.fail === true) {
			res.status(500).json({ error: "boom" });
			return;
		}
		sendData(res, { n: count, echo: req.body }, 201);
	};
	const router = Router().post("/", idempotency.middleware, create);
	const { app } = buildTestProduct({ extraProtectedMounts: [{ path: "/widgets", router }] });
	return {
		calls: () => count,
		purge: idempotency.purgeExpired,
		token: async (): Promise<string> => {
			await request(app).post("/api/v1/auth/register").send(credentials());
			const response = await request(app).post("/api/v1/auth/login").send(credentials());
			return response.body.data.accessToken as string;
		},
		post: (token: string, key: string | undefined, body: object) => {
			const call = request(app)
				.post("/api/v1/widgets")
				.set("Authorization", `Bearer ${token}`)
				.send(body);
			return key === undefined ? call : call.set("Idempotency-Key", key);
		},
	};
};

describe("idempotency", () => {
	it("passes requests without a key straight through", async () => {
		const h = harness();
		const token = await h.token();
		await h.post(token, undefined, { a: 1 });
		await h.post(token, undefined, { a: 1 });
		expect(h.calls()).toBe(2);
		expect(await prisma.idempotencyKey.count()).toBe(0);
	});

	it("replays the stored response for the same key and body", async () => {
		const h = harness();
		const token = await h.token();
		const first = await h.post(token, "key-12345678", { a: 1, b: { c: 2, d: 3 } });
		const second = await h.post(token, "key-12345678", { b: { d: 3, c: 2 }, a: 1 });
		expect(first.status).toBe(201);
		expect(second.status).toBe(201);
		expect(second.body).toEqual(first.body);
		expect(second.headers["idempotent-replayed"]).toBe("true");
		expect(first.headers["idempotent-replayed"]).toBeUndefined();
		expect(h.calls()).toBe(1);
	});

	it("answers 422 when the same key is reused with a different body", async () => {
		const h = harness();
		const token = await h.token();
		await h.post(token, "key-12345678", { a: 1 });
		const reused = await h.post(token, "key-12345678", { a: 2 });
		expect(reused.status).toBe(422);
		expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
		expect(h.calls()).toBe(1);
	});

	it("scopes keys per user", async () => {
		const h = harness();
		const token = await h.token();
		await h.post(token, "key-12345678", { a: 1 });
		await prisma.idempotencyKey.updateMany({ data: { userId: "someone-else" } });
		const again = await h.post(token, "key-12345678", { a: 1 });
		expect(again.headers["idempotent-replayed"]).toBeUndefined();
		expect(h.calls()).toBe(2);
	});

	it("rejects malformed keys", async () => {
		const h = harness();
		const token = await h.token();
		for (const key of ["short", "x".repeat(129), "has space in it", "bad/key/value"]) {
			const response = await h.post(token, key, { a: 1 });
			expect(response.status, key).toBe(400);
		}
		expect(h.calls()).toBe(0);
	});

	it("answers 409 while the first request with the key is still running", async () => {
		const h = harness({ slowMs: 300 });
		const token = await h.token();
		const first = h.post(token, "key-12345678", { a: 1 }).then((response) => response);
		await new Promise((resolve) => setTimeout(resolve, 100));
		const concurrent = await h.post(token, "key-12345678", { a: 1 });
		expect(concurrent.status).toBe(409);
		expect(concurrent.body.error.code).toBe("IDEMPOTENCY_IN_PROGRESS");
		expect((await first).status).toBe(201);
		expect(h.calls()).toBe(1);
	});

	it("does not store server errors so the client can retry", async () => {
		const h = harness({ fail: true });
		const token = await h.token();
		const first = await h.post(token, "key-12345678", { a: 1 });
		const second = await h.post(token, "key-12345678", { a: 1 });
		expect(first.status).toBe(500);
		expect(second.status).toBe(500);
		expect(h.calls()).toBe(2);
		expect(await prisma.idempotencyKey.count()).toBe(0);
	});

	it("treats an expired key as new and purges expired rows", async () => {
		let current = new Date("2026-01-01T00:00:00Z");
		const h = harness({ ttlMs: 1000, now: () => current });
		const token = await h.token();
		await h.post(token, "key-12345678", { a: 1 });
		current = new Date("2026-01-01T00:00:05Z");
		const again = await h.post(token, "key-12345678", { a: 2 });
		expect(again.status).toBe(201);
		expect(h.calls()).toBe(2);
		current = new Date("2026-01-02T00:00:00Z");
		expect(await h.purge()).toBe(1);
		expect(await prisma.idempotencyKey.count()).toBe(0);
	});

	it("keeps the request hash and response but no credentials in the table", async () => {
		const h = harness();
		const token = await h.token();
		await h.post(token, "key-12345678", { a: 1 });
		const row = await prisma.idempotencyKey.findFirstOrThrow();
		expect(row.requestHash).toMatch(/^[a-f0-9]{64}$/);
		expect(row.responseStatus).toBe(201);
		expect(JSON.stringify(row)).not.toContain(token);
	});
});
