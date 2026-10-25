import request from "supertest";
import { describe, expect, it } from "vitest";
import {
	buildTestProduct,
	cookiePair,
	credentials,
	PASSWORD,
	refreshCookieOf,
} from "../../../../test/helpers.js";
import { prisma } from "../../../infrastructure/database.js";
import { logger } from "../../../infrastructure/logger.js";
import { createAuditModule } from "../index.js";

const { app } = buildTestProduct();

const register = (body: object = credentials()) =>
	request(app).post("/api/v1/auth/register").send(body);
const login = (body: object = credentials()) => request(app).post("/api/v1/auth/login").send(body);
const refresh = (cookie: string) =>
	request(app)
		.post("/api/v1/auth/refresh")
		.set("X-Requested-With", "factory")
		.set("Cookie", cookiePair(cookie));
const logout = (cookie: string) =>
	request(app)
		.post("/api/v1/auth/logout")
		.set("X-Requested-With", "factory")
		.set("Cookie", cookiePair(cookie));

const actions = async (): Promise<string[]> =>
	(await prisma.auditEvent.findMany({ orderBy: { createdAt: "asc" } })).map((e) => e.action);

describe("audit trail for auth events", () => {
	it("records register, login, refresh and logout with ids, ip and request id only", async () => {
		const registered = await register();
		const userId = registered.body.data.user.id as string;
		const session = await login();
		const cookie = refreshCookieOf(session);
		const rotated = await refresh(cookie);
		const next = refreshCookieOf(rotated);
		await logout(next);
		expect(await actions()).toEqual(["auth.register", "auth.login", "auth.refresh", "auth.logout"]);
		const events = await prisma.auditEvent.findMany();
		for (const event of events) {
			expect(event.actorId).toBe(userId);
			expect(event.ip).toBeTruthy();
			expect(event.requestId).toBeTruthy();
			expect(JSON.stringify(event)).not.toContain("ada@example.com");
			expect(JSON.stringify(event)).not.toContain(PASSWORD);
		}
		const loginEvent = events.find((e) => e.action === "auth.login");
		expect(loginEvent?.requestId).toBe(session.headers["x-request-id"]);
	});

	it("records failed logins without the email and reuse of a rotated refresh token", async () => {
		await register();
		await login({ email: "ada@example.com", password: "wrong password here" });
		await login({ email: "ghost@example.com", password: PASSWORD });
		const session = await login();
		const cookie = refreshCookieOf(session);
		await refresh(cookie);
		const reuse = await refresh(cookie);
		expect(reuse.status).toBe(401);
		expect(await actions()).toEqual([
			"auth.register",
			"auth.login_failed",
			"auth.login_failed",
			"auth.login",
			"auth.refresh",
			"auth.refresh_reuse_detected",
		]);
		const serialized = JSON.stringify(await prisma.auditEvent.findMany());
		expect(serialized).not.toContain("ghost@example.com");
		expect(serialized).not.toContain("ada@example.com");
	});
});

describe("audit append-only table", () => {
	it("rejects UPDATE and DELETE on existing rows", async () => {
		const audit = createAuditModule({ prisma, logger });
		const written = await audit.record({ action: "demo.created", actorId: "u1" });
		expect(written.success).toBe(true);
		await expect(
			prisma.auditEvent.updateMany({ data: { action: "demo.changed" } }),
		).rejects.toThrow(/append-only/);
		await expect(prisma.auditEvent.deleteMany()).rejects.toThrow(/append-only/);
		expect(await actions()).toEqual(["demo.created"]);
	});
});

describe("audit recorder helper", () => {
	it("returns a failure result for an invalid action instead of throwing", async () => {
		const audit = createAuditModule({ prisma, logger });
		const invalid = await audit.record({ action: "Not Valid" });
		expect(invalid).toEqual({ success: false, error: "invalid_audit_event" });
		expect(await prisma.auditEvent.count()).toBe(0);
	});

	it("returns a failure result when the database write fails", async () => {
		const broken = {
			auditEvent: { create: () => Promise.reject(new Error("db down")) },
		} as unknown as typeof prisma;
		const audit = createAuditModule({ prisma: broken, logger });
		expect(await audit.record({ action: "demo.created" })).toEqual({
			success: false,
			error: "audit_write_failed",
		});
	});
});

describe("GET /api/v1/audit/events", () => {
	const tokenFor = async (email: string): Promise<string> => {
		await register(credentials(email));
		const response = await login(credentials(email));
		return response.body.data.accessToken as string;
	};
	const events = (token: string, query = "") =>
		request(app).get(`/api/v1/audit/events${query}`).set("Authorization", `Bearer ${token}`);

	it("requires authentication", async () => {
		expect((await request(app).get("/api/v1/audit/events")).status).toBe(401);
	});

	it("lists only the caller's events, newest first, in bounded pages", async () => {
		const token = await tokenFor("a@example.com");
		await tokenFor("b@example.com");
		const first = await events(token, "?limit=1");
		expect(first.status).toBe(200);
		expect(first.body.data).toHaveLength(1);
		expect(first.body.data[0].action).toBe("auth.login");
		expect(first.body.data[0].actorId).toBeUndefined();
		expect(first.body.meta.page).toEqual({ limit: 1, offset: 0, hasMore: true });
		const second = await events(token, "?limit=1&offset=1");
		expect(second.body.data[0].action).toBe("auth.register");
		expect(second.body.meta.page).toEqual({ limit: 1, offset: 1, hasMore: false });
		const all = await events(token);
		expect(all.body.data).toHaveLength(2);
		expect(all.body.meta.page.limit).toBe(20);
	});

	it("rejects an unbounded or malformed page request", async () => {
		const token = await tokenFor("a@example.com");
		for (const query of ["?limit=101", "?limit=0", "?offset=-1", "?limit=x"]) {
			const response = await events(token, query);
			expect(response.status, query).toBe(400);
			expect(response.body.error.code).toBe("VALIDATION_ERROR");
		}
	});
});
