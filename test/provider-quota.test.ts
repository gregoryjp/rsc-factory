import { describe, expect, it } from "vitest";
import {
	backoffDelayMs,
	classifyProviderText,
	parseResetTime,
} from "../src/domain/provider/quota.js";

const SESSION = "API Error: You've hit your session limit · resets 7:30am (Europe/Madrid)";

describe("classifyProviderText", () => {
	it("treats the real Pro session-limit message as quota exhaustion even with a 429", () => {
		expect(classifyProviderText(`429 rate_limit ${SESSION}`)).toBe("quota_exhausted");
	});

	it.each([
		"You've hit your usage limit",
		"Claude usage limit reached",
		"weekly limit reached, resets Monday",
	])("classifies %s as quota exhaustion", (text) => {
		expect(classifyProviderText(text)).toBe("quota_exhausted");
	});

	it.each([
		"API Error: 429 rate_limit_error",
		"HTTP 529 overloaded_error",
		"Overloaded",
		"rate limited, retry later",
	])("classifies %s as transient", (text) => {
		expect(classifyProviderText(text)).toBe("rate_limited_transient");
	});

	it("returns null for unrelated errors", () => {
		expect(classifyProviderText("syntax error in prompt")).toBeNull();
	});
});

describe("parseResetTime", () => {
	const now = Date.UTC(2026, 9, 24, 3, 0, 0);

	it("resolves the next occurrence in the named time zone (Madrid is UTC+2 in October)", () => {
		expect(parseResetTime(SESSION, now)).toBe(Date.UTC(2026, 9, 24, 5, 30, 0));
	});

	it("rolls to the next day when the time already passed today (and DST has ended by then)", () => {
		const later = Date.UTC(2026, 9, 24, 6, 0, 0);
		expect(parseResetTime(SESSION, later)).toBe(Date.UTC(2026, 9, 25, 6, 30, 0));
	});

	it("supports hour-only times with a time zone", () => {
		expect(parseResetTime("limit reached, resets 7am (UTC)", now)).toBe(
			Date.UTC(2026, 9, 24, 7, 0, 0),
		);
	});

	it("handles 12am and 12pm", () => {
		expect(parseResetTime("resets 12am (UTC)", now)).toBe(Date.UTC(2026, 9, 25, 0, 0, 0));
		expect(parseResetTime("resets 12pm (UTC)", now)).toBe(Date.UTC(2026, 9, 24, 12, 0, 0));
	});

	it("follows the offset change across a DST boundary", () => {
		const before = Date.UTC(2026, 9, 24, 12, 0, 0);
		expect(parseResetTime("resets 7:30am (Europe/Madrid)", before)).toBe(
			Date.UTC(2026, 9, 25, 6, 30, 0),
		);
		const eve = Date.UTC(2026, 9, 24, 22, 0, 0);
		expect(parseResetTime("resets 7:30am (Europe/Madrid)", eve)).toBe(
			Date.UTC(2026, 9, 25, 6, 30, 0),
		);
		const sat = Date.UTC(2026, 9, 25, 12, 0, 0);
		expect(parseResetTime("resets 7:30am (Europe/Madrid)", sat)).toBe(
			Date.UTC(2026, 9, 26, 6, 30, 0),
		);
	});

	it("returns null when unparseable or the zone is invalid", () => {
		expect(parseResetTime("session limit, try later", now)).toBeNull();
		expect(parseResetTime("resets 7:30am (Mars/Olympus)", now)).toBeNull();
		expect(parseResetTime("resets 25am (UTC)", now)).toBeNull();
	});
});

describe("backoffDelayMs", () => {
	it("applies full jitter under an exponential cap", () => {
		const cfg = { baseMs: 2000, capMs: 60_000 };
		expect(backoffDelayMs(1, cfg, () => 1)).toBe(2000);
		expect(backoffDelayMs(2, cfg, () => 1)).toBe(4000);
		expect(backoffDelayMs(3, cfg, () => 0.5)).toBe(4000);
		expect(backoffDelayMs(10, cfg, () => 1)).toBe(60_000);
		expect(backoffDelayMs(2, cfg, () => 0)).toBe(0);
	});
});
