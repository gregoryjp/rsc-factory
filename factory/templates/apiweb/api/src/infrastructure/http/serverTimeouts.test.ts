import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { configureServerTimeouts } from "./serverTimeouts.js";

describe("configureServerTimeouts", () => {
	it("bounds header, request and idle connection time", () => {
		const server = createServer();
		configureServerTimeouts(server, { requestTimeoutMs: 30_000 });
		expect(server.requestTimeout).toBe(35_000);
		expect(server.headersTimeout).toBe(15_000);
		expect(server.keepAliveTimeout).toBe(5_000);
		expect(server.headersTimeout).toBeLessThanOrEqual(server.requestTimeout);
	});

	it("keeps the header timeout below a short request timeout", () => {
		const server = createServer();
		configureServerTimeouts(server, { requestTimeoutMs: 100 });
		expect(server.headersTimeout).toBeLessThanOrEqual(server.requestTimeout);
	});
});
