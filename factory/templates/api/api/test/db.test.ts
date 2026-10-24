import { describe, expect, it } from "vitest";
import { assertTestDatabase } from "./db.js";

const valid = {
	NODE_ENV: "test",
	TEST_DATABASE_URL: "postgresql://u:p@host:5432/app_test",
	DATABASE_URL: "postgresql://u:p@host:5432/app_test",
};

describe("assertTestDatabase", () => {
	it("accepts a test database", () => {
		expect(() => assertTestDatabase(valid)).not.toThrow();
	});

	it("rejects a non-test NODE_ENV", () => {
		expect(() => assertTestDatabase({ ...valid, NODE_ENV: "development" })).toThrow(/NODE_ENV/);
	});

	it("rejects a missing TEST_DATABASE_URL", () => {
		expect(() => assertTestDatabase({ ...valid, TEST_DATABASE_URL: undefined })).toThrow(/not set/);
	});

	it("rejects a database whose name does not end in _test", () => {
		const url = "postgresql://u:p@host:5432/app";
		expect(() =>
			assertTestDatabase({ ...valid, TEST_DATABASE_URL: url, DATABASE_URL: url }),
		).toThrow(/_test/);
	});

	it("rejects a DATABASE_URL that differs from TEST_DATABASE_URL", () => {
		expect(() =>
			assertTestDatabase({ ...valid, DATABASE_URL: "postgresql://u:p@host:5432/app" }),
		).toThrow(/DATABASE_URL/);
	});
});
