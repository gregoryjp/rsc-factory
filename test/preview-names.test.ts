import { describe, expect, it } from "vitest";
import { shotName } from "../factory/preview/names.mjs";

const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
const SHOT = /^shots\/[A-Za-z0-9._-]+\.png$/;

describe("screenshot names", () => {
	it("keeps routes whose slugs collide apart by route index", () => {
		const a = shotName({ index: 0, route: "/a-b", role: null, viewport: MOBILE });
		const b = shotName({ index: 1, route: "/a/b", role: null, viewport: MOBILE });
		expect(a).not.toBe(b);
	});

	it("separates viewports and roles for the same route", () => {
		const names = [
			shotName({ index: 2, route: "/t", role: null, viewport: MOBILE }),
			shotName({ index: 2, route: "/t", role: null, viewport: DESKTOP }),
			shotName({ index: 3, route: "/t", role: "admin", viewport: MOBILE }),
			shotName({ index: 4, route: "/t", role: "cliente", viewport: MOBILE }),
		];
		expect(new Set(names).size).toBe(names.length);
		for (const name of names) expect(name).toMatch(SHOT);
	});

	it("produces safe names for hostile routes and long slugs", () => {
		const name = shotName({
			index: 9,
			route: `/${"x".repeat(500)}%2e%2e/ü`,
			role: null,
			viewport: DESKTOP,
		});
		expect(name).toMatch(SHOT);
		expect(name.length).toBeLessThan(120);
	});
});
