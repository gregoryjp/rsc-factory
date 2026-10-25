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

const { app } = buildTestProduct();

const register = (body: object = credentials()) =>
	request(app).post("/api/v1/auth/register").send(body);
const login = (body: object = credentials()) => request(app).post("/api/v1/auth/login").send(body);
const refresh = (cookie: string) =>
	request(app)
		.post("/api/v1/auth/refresh")
		.set("X-Requested-With", "factory")
		.set("Cookie", cookiePair(cookie));
const me = (token: string) =>
	request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${token}`);

const registerAndLogin = async () => {
	await register();
	const response = await login();
	return {
		response,
		accessToken: response.body.data.accessToken as string,
		cookie: refreshCookieOf(response),
	};
};

describe("auth", () => {
	it("registers, logs in and returns the current user", async () => {
		const registered = await register();
		expect(registered.status).toBe(201);
		expect(registered.body.data.user).toMatchObject({ email: "ada@example.com", role: "USER" });
		expect(registered.body.data.user.passwordHash).toBeUndefined();
		const response = await login();
		const accessToken = response.body.data.accessToken as string;
		const cookie = refreshCookieOf(response);
		expect(response.status).toBe(200);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Strict");
		expect(cookie).toContain("Path=/api/v1/auth");
		expect(cookie).not.toContain("Secure");
		expect(accessToken).not.toBe("");
		const current = await me(accessToken);
		expect(current.status).toBe(200);
		expect(current.body.data.user.email).toBe("ada@example.com");
	});

	it("rejects registering the same email twice and weak passwords", async () => {
		await register();
		expect((await register()).status).toBe(409);
		const short = await register({ email: "b@example.com", password: "short" });
		expect(short.status).toBe(400);
		const long = await register({ email: "b@example.com", password: "x".repeat(129) });
		expect(long.status).toBe(400);
	});

	it("returns the same generic error for a wrong password and an unknown user", async () => {
		await register();
		const wrong = await login({ email: "ada@example.com", password: "wrong password here" });
		const unknown = await login({ email: "nobody@example.com", password: PASSWORD });
		expect(wrong.status).toBe(401);
		expect(unknown.status).toBe(401);
		expect(wrong.body.error.code).toBe("UNAUTHORIZED");
		expect(wrong.body.error.message).toBe(unknown.body.error.message);
		expect(wrong.headers["set-cookie"]).toBeUndefined();
	});

	it("stores only hashes of the issued tokens", async () => {
		const { accessToken, cookie } = await registerAndLogin();
		const refreshToken = cookiePair(cookie).split("=")[1] ?? "";
		const sessions = await prisma.session.findMany();
		expect(sessions).toHaveLength(1);
		const serialized = JSON.stringify(sessions);
		expect(serialized).not.toContain(accessToken);
		expect(serialized).not.toContain(refreshToken);
		expect(sessions[0]?.accessTokenHash).toMatch(/^[0-9a-f]{64}$/);
		const users = await prisma.user.findMany();
		expect(users[0]?.passwordHash.startsWith("$argon2id$")).toBe(true);
		expect(JSON.stringify(users)).not.toContain(PASSWORD);
	});

	it("rotates the refresh token and invalidates the previous access token", async () => {
		const first = await registerAndLogin();
		const rotated = await refresh(first.cookie);
		expect(rotated.status).toBe(200);
		const nextCookie = refreshCookieOf(rotated);
		expect(cookiePair(nextCookie)).not.toBe(cookiePair(first.cookie));
		expect((await me(rotated.body.data.accessToken)).status).toBe(200);
		expect((await me(first.accessToken)).status).toBe(401);
	});

	it("revokes the whole session family when an old refresh token is reused", async () => {
		const first = await registerAndLogin();
		const rotated = await refresh(first.cookie);
		const nextCookie = refreshCookieOf(rotated);
		const reuse = await refresh(first.cookie);
		expect(reuse.status).toBe(401);
		expect((await refresh(nextCookie)).status).toBe(401);
		expect((await me(rotated.body.data.accessToken)).status).toBe(401);
	});

	it("rejects an expired refresh token and a missing cookie", async () => {
		const first = await registerAndLogin();
		await prisma.session.updateMany({ data: { refreshExpiresAt: new Date(Date.now() - 1000) } });
		expect((await refresh(first.cookie)).status).toBe(401);
		const missing = await request(app)
			.post("/api/v1/auth/refresh")
			.set("X-Requested-With", "factory");
		expect(missing.status).toBe(401);
	});

	it("rejects an expired access token", async () => {
		const { accessToken } = await registerAndLogin();
		await prisma.session.updateMany({ data: { accessExpiresAt: new Date(Date.now() - 1000) } });
		expect((await me(accessToken)).status).toBe(401);
	});

	it("logout invalidates the access and refresh tokens and clears the cookie", async () => {
		const { accessToken, cookie } = await registerAndLogin();
		const response = await request(app)
			.post("/api/v1/auth/logout")
			.set("X-Requested-With", "factory")
			.set("Cookie", cookiePair(cookie));
		expect(response.status).toBe(204);
		expect(String(response.headers["set-cookie"])).toContain("refresh_token=;");
		expect((await me(accessToken)).status).toBe(401);
		expect((await refresh(cookie)).status).toBe(401);
	});

	it("rejects a disabled user at login, on existing tokens and on refresh", async () => {
		const { accessToken, cookie } = await registerAndLogin();
		await prisma.user.updateMany({ data: { disabledAt: new Date() } });
		expect((await me(accessToken)).status).toBe(401);
		expect((await refresh(cookie)).status).toBe(401);
		const attempt = await login();
		expect(attempt.status).toBe(401);
		expect(attempt.body.error.message).toBe("Invalid credentials");
	});

	it("requires the CSRF header and an allowed Origin on cookie endpoints", async () => {
		const { cookie } = await registerAndLogin();
		const noHeader = await request(app)
			.post("/api/v1/auth/refresh")
			.set("Cookie", cookiePair(cookie));
		expect(noHeader.status).toBe(403);
		expect(noHeader.body.error.code).toBe("FORBIDDEN");
		const foreignOrigin = await request(app)
			.post("/api/v1/auth/refresh")
			.set("X-Requested-With", "factory")
			.set("Origin", "https://evil.example")
			.set("Cookie", cookiePair(cookie));
		expect(foreignOrigin.status).toBe(403);
		const logoutNoHeader = await request(app)
			.post("/api/v1/auth/logout")
			.set("Cookie", cookiePair(cookie));
		expect(logoutNoHeader.status).toBe(403);
		expect((await refresh(cookie)).status).toBe(200);
	});
});
