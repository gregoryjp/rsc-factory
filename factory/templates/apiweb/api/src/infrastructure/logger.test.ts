import { Writable } from "node:stream";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "./http/app.js";
import { createLogger } from "./logger.js";

const capture = () => {
	const lines: string[] = [];
	const destination = new Writable({
		write(chunk, _encoding, callback) {
			lines.push(String(chunk));
			callback();
		},
	});
	return { destination, text: () => lines.join("") };
};

describe("structured logging", () => {
	it("redacts secrets and tokens at any logged depth", () => {
		const sink = capture();
		const log = createLogger({ level: "info", destination: sink.destination });
		log.info(
			{
				req: {
					headers: {
						authorization: "Bearer AUTHSECRET",
						cookie: "refresh_token=COOKIESECRET",
						"x-api-key": "APIKEYSECRET",
						"x-csrf-token": "CSRFSECRET",
					},
					body: { password: "PASSWORDSECRET" },
				},
				res: { headers: { "set-cookie": ["refresh_token=SETCOOKIESECRET"] } },
				user: { passwordHash: "HASHSECRET", token: "TOKENSECRET", secret: "SECRETSECRET" },
				tokens: { accessToken: "ACCESSSECRET", refreshToken: "REFRESHSECRET" },
				session: { accessTokenHash: "ATHASH", refreshTokenHash: "RTHASH" },
				config: { apiKey: "CONFIGKEYSECRET" },
			},
			"probe",
		);
		const output = sink.text();
		expect(output).toContain("probe");
		expect(output).not.toMatch(/[A-Z]*SECRET|ATHASH|RTHASH/);
	});

	it("logs each request with its request id and without credentials", async () => {
		const sink = capture();
		const log = createLogger({ level: "info", destination: sink.destination });
		const router = express.Router().get("/boom", () => {
			throw new Error("exploded");
		});
		const app = createApp({
			logger: log,
			corsOrigins: [],
			production: false,
			trustProxy: false,
			rateLimiter: (_req, _res, next) => next(),
			requestTimeoutMs: 5000,
			bodyLimits: [],
			mounts: [{ path: "/t", router }],
		});
		const response = await request(app)
			.get("/t/boom")
			.set("x-request-id", "req-abcdef123")
			.set("Authorization", "Bearer LEAKME")
			.set("Cookie", "refresh_token=LEAKME");
		expect(response.status).toBe(500);
		const lines = sink.text().trim().split("\n");
		const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
		const errorLine = parsed.find((line) => line.msg === "unhandled error");
		expect((errorLine?.req as { id?: string } | undefined)?.id).toBe("req-abcdef123");
		const completed = parsed.find((line) => line.msg === "request errored");
		expect((completed?.req as { id?: string } | undefined)?.id).toBe("req-abcdef123");
		expect(sink.text()).not.toContain("LEAKME");
	});
});
