import express, { type Request, type Response, Router } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildTestProduct, credentials, PASSWORD } from "../../../test/helpers.js";
import { buildProduct, PUBLIC_API_ROUTES } from "../../composition.js";
import { logger } from "../logger.js";
import { composeApiRouter, routeKey } from "./apiRouter.js";
import { createApp } from "./app.js";
import { createRequireAuth, getAuth, requireRole } from "./auth.js";
import { createCsrfProtection } from "./csrf.js";
import { assertOwned } from "./ownership.js";
import { sendData } from "./respond.js";

const withLimits = (max: number, authMax: number) =>
	buildProduct({ rateLimit: { windowMs: 60_000, max, authMax } });

describe("rate limiting", () => {
	it("answers 429 with the error envelope once the global limit is hit", async () => {
		const { app } = withLimits(3, 3);
		for (let i = 0; i < 3; i += 1) {
			expect((await request(app).get("/nope")).status).toBe(404);
		}
		const limited = await request(app).get("/nope");
		expect(limited.status).toBe(429);
		expect(limited.body.error.code).toBe("RATE_LIMITED");
		expect(typeof limited.body.error.requestId).toBe("string");
		expect(limited.headers["ratelimit-policy"]).toBeDefined();
	});

	it("applies a stricter limit to login, register and refresh", async () => {
		const { app } = withLimits(50, 2);
		const attempt = () => request(app).post("/api/v1/auth/login").send(credentials());
		expect((await attempt()).status).toBe(401);
		expect((await attempt()).status).toBe(401);
		expect((await attempt()).status).toBe(429);
		expect((await request(app).get("/nope")).status).toBe(404);
		const register = await request(app).post("/api/v1/auth/register").send(credentials());
		expect(register.status).toBe(429);
	});

	it("keys the counter per client IP and ignores X-Forwarded-For by default", async () => {
		const { app } = withLimits(2, 2);
		const hit = (ip: string) => request(app).get("/nope").set("X-Forwarded-For", ip);
		expect((await hit("203.0.113.1")).status).toBe(404);
		expect((await hit("203.0.113.2")).status).toBe(404);
		expect((await hit("203.0.113.3")).status).toBe(429);
	});

	it("never rate limits the health probes", async () => {
		const { app } = withLimits(1, 1);
		for (let i = 0; i < 4; i += 1) {
			expect((await request(app).get("/health/live")).status).toBe(200);
		}
	});
});

describe("hardening", () => {
	it("sends strict security headers for a JSON API", async () => {
		const { app } = buildTestProduct();
		const response = await request(app).get("/health/live");
		expect(response.headers["content-security-policy"]).toBe(
			"default-src 'none';frame-ancestors 'none'",
		);
		expect(response.headers["referrer-policy"]).toBe("no-referrer");
		expect(response.headers["x-content-type-options"]).toBe("nosniff");
		expect(response.headers["x-powered-by"]).toBeUndefined();
		expect(response.headers["strict-transport-security"]).toBeUndefined();
	});

	it("enables HSTS only in production", async () => {
		const build = (production: boolean) =>
			createApp({
				logger,
				corsOrigins: [],
				mounts: [],
				production,
				trustProxy: false,
				rateLimiter: (_req, _res, next) => next(),
				requestTimeoutMs: 1000,
				bodyLimits: [],
			});
		const prod = await request(build(true)).get("/x");
		expect(prod.headers["strict-transport-security"]).toContain("max-age=31536000");
		const dev = await request(build(false)).get("/x");
		expect(dev.headers["strict-transport-security"]).toBeUndefined();
	});

	it("rejects auth bodies above 10kb with the envelope", async () => {
		const { app } = buildTestProduct();
		const response = await request(app)
			.post("/api/v1/auth/login")
			.send({ email: "a@example.com", password: "x".repeat(11_000) });
		expect(response.status).toBe(413);
		expect(response.body.error.code).toBe("PAYLOAD_TOO_LARGE");
	});

	it("answers 503 when a request exceeds the timeout", async () => {
		const slow = Router().get("/", () => undefined);
		const { app: authApp } = buildTestProduct({
			extraProtectedMounts: [{ path: "/slow", router: slow }],
		});
		const { app } = buildTestProduct({
			requestTimeoutMs: 100,
			extraProtectedMounts: [{ path: "/slow", router: slow }],
		});
		const login = await request(authApp).post("/api/v1/auth/register").send(credentials());
		expect(login.status).toBe(201);
		const session = await request(authApp).post("/api/v1/auth/login").send(credentials());
		const response = await request(app)
			.get("/api/v1/slow")
			.set("Authorization", `Bearer ${session.body.data.accessToken}`);
		expect(response.status).toBe(503);
		expect(response.body.error.code).toBe("REQUEST_TIMEOUT");
	});
});

describe("csrf protection", () => {
	const protectedApp = (origins: readonly string[]) => {
		const router = Router().post("/x", createCsrfProtection(origins), (_req, res) => {
			sendData(res, { ok: true });
		});
		return { router };
	};

	it("accepts only the custom header with an allowlisted or absent Origin", async () => {
		const { router } = protectedApp(["https://app.example"]);
		const wrapper = express();
		wrapper.use(router);
		wrapper.use((error: unknown, _req: Request, res: Response, _next: () => void) => {
			res.status((error as { status?: number }).status ?? 500).end();
		});
		const ok = await request(wrapper)
			.post("/x")
			.set("X-Requested-With", "factory")
			.set("Origin", "https://app.example");
		expect(ok.status).toBe(200);
		const foreign = await request(wrapper)
			.post("/x")
			.set("X-Requested-With", "factory")
			.set("Origin", "https://evil.example");
		expect(foreign.status).toBe(403);
		expect((await request(wrapper).post("/x")).status).toBe(403);
	});
});

describe("default-deny authorization", () => {
	const probe = (method: string, path: string) =>
		method === "POST"
			? request(buildTestProduct().app).post(path)
			: request(buildTestProduct().app).get(path);

	it("keeps the public surface equal to the explicit allowlist", () => {
		const { routes } = buildProduct();
		const publicKeys = routes
			.filter((route) => route.access === "public")
			.map((route) => `${route.method} ${route.path.replace("/api/v1", "")}`);
		expect([...publicKeys].sort()).toEqual([...PUBLIC_API_ROUTES].sort());
		expect(routes.length).toBeGreaterThan(publicKeys.length);
	});

	it("answers 401 to every non-allowlisted route without a token", async () => {
		const extra = Router().get("/", (_req, res) => {
			sendData(res, []);
		});
		const { routes } = buildProduct({ extraProtectedMounts: [{ path: "/things", router: extra }] });
		const protectedRoutes = routes.filter((route) => route.access === "protected");
		expect(protectedRoutes.map(routeKey)).toContain("GET /api/v1/things");
		for (const route of protectedRoutes) {
			const response = await probe(route.method, route.path);
			expect(response.status, routeKey(route)).toBe(401);
		}
	});

	it("fails composition when a router exposes a public route that is not allowlisted", () => {
		const rogue = Router().get("/leak", () => undefined);
		expect(() =>
			composeApiRouter({
				requireAuth: createRequireAuth(async () => null),
				publicMounts: [{ path: "/rogue", router: rogue }],
				protectedMounts: [],
				publicAllowlist: [],
			}),
		).toThrow(/allowlist/);
	});

	it("fails composition when the allowlist has a stale entry or a nested router", () => {
		expect(() =>
			composeApiRouter({
				requireAuth: createRequireAuth(async () => null),
				publicMounts: [],
				protectedMounts: [],
				publicAllowlist: ["GET /gone"],
			}),
		).toThrow(/not mounted/);
		const nested = Router().use(
			"/inner",
			Router().get("/a", () => undefined),
		);
		expect(() =>
			composeApiRouter({
				requireAuth: createRequireAuth(async () => null),
				publicMounts: [],
				protectedMounts: [{ path: "/n", router: nested }],
				publicAllowlist: [],
			}),
		).toThrow(/flat routes/);
	});

	it("enforces roles and denies cross-user access without revealing existence", async () => {
		type Note = { id: string; ownerId: string };
		const notes = new Map<string, Note>();
		const router = Router()
			.post("/", (_req, res) => {
				const note = { id: `note-${notes.size + 1}`, ownerId: getAuth(res).userId };
				notes.set(note.id, note);
				sendData(res, note, 201);
			})
			.get("/:id", (req, res) => {
				sendData(res, assertOwned(notes.get(String(req.params.id)), getAuth(res)));
			})
			.get("/admin/only", requireRole("ADMIN"), (_req, res) => {
				sendData(res, { admin: true });
			});
		const { app } = buildTestProduct({ extraProtectedMounts: [{ path: "/notes", router }] });
		const tokenFor = async (email: string) => {
			await request(app).post("/api/v1/auth/register").send({ email, password: PASSWORD });
			const response = await request(app)
				.post("/api/v1/auth/login")
				.send({ email, password: PASSWORD });
			return response.body.data.accessToken as string;
		};
		const alice = await tokenFor("alice@example.com");
		const bob = await tokenFor("bob@example.com");
		const created = await request(app)
			.post("/api/v1/notes")
			.set("Authorization", `Bearer ${alice}`);
		const id = created.body.data.id as string;
		expect(
			(await request(app).get(`/api/v1/notes/${id}`).set("Authorization", `Bearer ${alice}`))
				.status,
		).toBe(200);
		const foreign = await request(app)
			.get(`/api/v1/notes/${id}`)
			.set("Authorization", `Bearer ${bob}`);
		const missing = await request(app)
			.get("/api/v1/notes/does-not-exist")
			.set("Authorization", `Bearer ${bob}`);
		expect(foreign.status).toBe(404);
		expect(foreign.body.error.code).toBe(missing.body.error.code);
		expect(foreign.body.error.message).toBe(missing.body.error.message);
		const forbidden = await request(app)
			.get("/api/v1/notes/admin/only")
			.set("Authorization", `Bearer ${alice}`);
		expect(forbidden.status).toBe(403);
	});
});
