import { describe, expect, it } from "vitest";
import { classifyCodexError } from "../src/domain/provider/codex-quota.js";

const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);

describe("classifyCodexError", () => {
	it("reads reset time from the structured usage_limit_reached body (resets_at in seconds)", () => {
		const body = JSON.stringify({
			type: "error",
			status: 429,
			error: {
				type: "usage_limit_reached",
				message: "You've hit your usage limit.",
				resets_at: Math.floor(NOW / 1000) + 3600,
			},
		});
		expect(classifyCodexError(body, NOW)).toEqual({
			kind: "quota_exhausted",
			waitUntil: NOW + 3_600_000,
		});
	});

	it("falls back to resets_in_seconds", () => {
		const body = JSON.stringify({
			error: { type: "usage_limit_reached", message: "x", resets_in_seconds: 90 },
		});
		expect(classifyCodexError(body, NOW)).toEqual({
			kind: "quota_exhausted",
			waitUntil: NOW + 90_000,
		});
	});

	it("parses a relative reset from plain text", () => {
		const text = "You've hit your usage limit. Try again in 1 day 2 hours 30 minutes.";
		expect(classifyCodexError(text, NOW)).toEqual({
			kind: "quota_exhausted",
			waitUntil: NOW + (24 * 3600 + 2 * 3600 + 30 * 60) * 1000,
		});
	});

	it("parses an absolute date and time from plain text", () => {
		const text = "You've hit your usage limit. Try again at Oct 26th, 2026 3:12 PM.";
		const result = classifyCodexError(text, NOW);
		expect(result).toMatchObject({ kind: "quota_exhausted" });
		expect(result?.kind === "quota_exhausted" && result.waitUntil).toBe(
			new Date("Oct 26, 2026 3:12 PM").getTime(),
		);
	});

	it("reports quota exhaustion without a reset time when none is present", () => {
		expect(classifyCodexError("You've hit your usage limit.", NOW)).toEqual({
			kind: "quota_exhausted",
			waitUntil: null,
		});
	});

	it("classifies 429 rate limits as transient", () => {
		const body = JSON.stringify({
			status: 429,
			error: { type: "rate_limit_exceeded", message: "Rate limit reached, slow down" },
		});
		expect(classifyCodexError(body, NOW)).toEqual({ kind: "rate_limited_transient" });
	});

	it("returns null for unrelated errors", () => {
		const body = JSON.stringify({
			status: 400,
			error: {
				type: "invalid_request_error",
				message: "model not supported",
				code: "model_not_found",
			},
		});
		expect(classifyCodexError(body, NOW)).toBeNull();
	});
});
