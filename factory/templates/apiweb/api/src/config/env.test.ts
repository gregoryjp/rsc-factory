import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.js";

const base = { DATABASE_URL: "postgresql://u:p@localhost:5432/db" };
const production = { ...base, NODE_ENV: "production", CORS_ORIGINS: "https://app.example" };

describe("security env", () => {
	it("applies safe defaults", () => {
		const env = parseEnv(base);
		expect(env.TRUST_PROXY).toBe(false);
		expect(env.RATE_LIMIT_MAX).toBeGreaterThan(env.RATE_LIMIT_AUTH_MAX);
		expect(env.REQUEST_TIMEOUT_MS).toBe(30_000);
	});

	it("accepts a proxy hop count and rejects a bare 'true'", () => {
		expect(parseEnv({ ...base, TRUST_PROXY: "1" }).TRUST_PROXY).toBe(1);
		expect(() => parseEnv({ ...base, TRUST_PROXY: "true" })).toThrow(/TRUST_PROXY/);
	});

	it("rejects an auth limit above the global limit", () => {
		expect(() => parseEnv({ ...base, RATE_LIMIT_MAX: "5", RATE_LIMIT_AUTH_MAX: "6" })).toThrow(
			/RATE_LIMIT_AUTH_MAX/,
		);
	});

	it("requires sane rate limit values in production", () => {
		expect(() => parseEnv(production)).not.toThrow();
		expect(() => parseEnv({ ...production, RATE_LIMIT_WINDOW_MS: "1000" })).toThrow(
			/RATE_LIMIT_WINDOW_MS/,
		);
		expect(() => parseEnv({ ...production, RATE_LIMIT_MAX: "100000" })).toThrow(/RATE_LIMIT_MAX/);
		expect(() =>
			parseEnv({ ...production, RATE_LIMIT_AUTH_MAX: "101", RATE_LIMIT_MAX: "500" }),
		).toThrow(/RATE_LIMIT_AUTH_MAX/);
	});

	it("defaults the idempotency TTL, shutdown timeout and leaves the migrator url unset", () => {
		const env = parseEnv(base);
		expect(env.IDEMPOTENCY_TTL_MS).toBe(86_400_000);
		expect(env.SHUTDOWN_TIMEOUT_MS).toBe(10_000);
		expect(env.MIGRATION_DATABASE_URL).toBeUndefined();
	});

	it("keeps the runtime off migrator and superuser credentials in production", () => {
		const migrator = "postgresql://app_migrator:p@db:5432/app";
		expect(() =>
			parseEnv({ ...production, DATABASE_URL: migrator, MIGRATION_DATABASE_URL: migrator }),
		).toThrow(/MIGRATION_DATABASE_URL/);
		expect(() =>
			parseEnv({
				...production,
				DATABASE_URL: "postgresql://app_runtime:p@db:5432/app",
				MIGRATION_DATABASE_URL: migrator,
			}),
		).not.toThrow();
		expect(() =>
			parseEnv({ ...production, DATABASE_URL: "postgresql://postgres:p@db:5432/app" }),
		).toThrow(/superuser/);
		expect(() =>
			parseEnv({
				...base,
				MIGRATION_DATABASE_URL: base.DATABASE_URL,
				DATABASE_URL: base.DATABASE_URL,
			}),
		).not.toThrow();
	});
});
