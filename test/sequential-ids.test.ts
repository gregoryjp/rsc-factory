import { describe, expect, it } from "vitest";
import { createSequentialIds } from "./helpers/env.js";
import { dockerIdSalt } from "./helpers/id-salt.js";

describe("createSequentialIds", () => {
	it("keeps plain sequential ids without a salt", () => {
		const ids = createSequentialIds("");
		expect([ids("run"), ids("run"), ids("chk")]).toEqual(["run_1", "run_2", "chk_3"]);
	});

	it("embeds the salt so two processes never share an object name", () => {
		const first = createSequentialIds("aa11bb")("run");
		const second = createSequentialIds("cc22dd")("run");
		expect(first).toBe("run_aa11bb_1");
		expect(first).not.toBe(second);
	});

	it("creates a different random salt per call, valid inside a docker object name", () => {
		const a = dockerIdSalt();
		const b = dockerIdSalt();
		expect(a).toMatch(/^[0-9a-f]{8}$/);
		expect(a).not.toBe(b);
	});
});
