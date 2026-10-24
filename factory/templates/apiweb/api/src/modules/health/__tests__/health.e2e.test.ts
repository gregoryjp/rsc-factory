import request from "supertest";
import { describe, expect, it } from "vitest";
import { createProductApp } from "../../../composition.js";

const app = createProductApp();

describe("health", () => {
	it("GET /health/live returns the success envelope", async () => {
		const response = await request(app).get("/health/live");
		expect(response.status).toBe(200);
		expect(response.body.data).toEqual({ status: "ok" });
		expect(typeof response.body.meta.requestId).toBe("string");
	});

	it("GET /health/ready pings the real database", async () => {
		const response = await request(app).get("/health/ready");
		expect(response.status).toBe(200);
		expect(response.body.data).toEqual({ status: "ok", checks: { database: "up" } });
	});

	it("echoes a valid x-request-id", async () => {
		const response = await request(app).get("/health/live").set("x-request-id", "req-12345678");
		expect(response.headers["x-request-id"]).toBe("req-12345678");
		expect(response.body.meta.requestId).toBe("req-12345678");
	});

	it("returns the error envelope for unknown routes", async () => {
		const response = await request(app).get("/nope");
		expect(response.status).toBe(404);
		expect(response.body.error.code).toBe("NOT_FOUND");
		expect(typeof response.body.error.requestId).toBe("string");
	});

	it("returns INVALID_JSON for malformed bodies", async () => {
		const response = await request(app)
			.post("/health/live")
			.set("content-type", "application/json")
			.send("{not json");
		expect(response.status).toBe(400);
		expect(response.body.error.code).toBe("INVALID_JSON");
	});
});
