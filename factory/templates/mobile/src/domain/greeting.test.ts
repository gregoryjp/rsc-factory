import { describe, expect, it } from "vitest";
import { formatGreeting } from "./greeting";

describe("formatGreeting", () => {
	it("greets by name", () => {
		expect(formatGreeting("Ana")).toBe("Hola, Ana");
	});

	it("falls back to a plain greeting for a blank name", () => {
		expect(formatGreeting("   ")).toBe("Hola");
	});
});
