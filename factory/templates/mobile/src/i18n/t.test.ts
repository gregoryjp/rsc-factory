import { describe, expect, it } from "vitest";
import { messages } from "./messages";
import { t } from "./t";

describe("t", () => {
	it("returns the message for a key", () => {
		expect(t("home.start")).toBe("Comenzar");
	});

	it("has a non-empty message for every key", () => {
		for (const text of Object.values(messages)) expect(text.trim()).not.toBe("");
	});
});
