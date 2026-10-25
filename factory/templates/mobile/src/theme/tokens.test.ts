import { describe, expect, it } from "vitest";
import { contrastRatio } from "./contrast";
import { darkColors, lightColors, selectColors } from "./tokens";

describe("selectColors", () => {
	it("selects the dark palette only for the dark scheme", () => {
		expect(selectColors("dark")).toBe(darkColors);
		expect(selectColors("light")).toBe(lightColors);
		expect(selectColors(null)).toBe(lightColors);
		expect(selectColors(undefined)).toBe(lightColors);
	});
});

describe.each([
	["light", lightColors],
	["dark", darkColors],
])("%s palette contrast", (_name, palette) => {
	it.each([
		["text", "background"],
		["text", "surface"],
		["muted", "background"],
		["onPrimary", "primary"],
	] as const)("%s on %s is at least 4.5:1", (fg, bg) => {
		expect(contrastRatio(palette[fg], palette[bg])).toBeGreaterThanOrEqual(4.5);
	});
});
