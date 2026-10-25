import { describe, expect, it } from "vitest";
import {
	DEFAULT_PAGE_LIMIT,
	MAX_PAGE_LIMIT,
	MAX_PAGE_OFFSET,
	pageWindow,
	parsePageQuery,
	toPage,
} from "./pagination.js";

describe("pagination", () => {
	it("applies the default limit and a zero offset", () => {
		expect(parsePageQuery({})).toEqual({ limit: DEFAULT_PAGE_LIMIT, offset: 0 });
	});

	it("coerces query strings", () => {
		expect(parsePageQuery({ limit: "5", offset: "10" })).toEqual({ limit: 5, offset: 10 });
	});

	it("rejects limits and offsets outside the hard bounds", () => {
		for (const query of [
			{ limit: String(MAX_PAGE_LIMIT + 1) },
			{ limit: "0" },
			{ limit: "-1" },
			{ limit: "abc" },
			{ limit: ["1", "2"] },
			{ offset: "-1" },
			{ offset: String(MAX_PAGE_OFFSET + 1) },
			{ offset: "1.5" },
		]) {
			expect(() => parsePageQuery(query), JSON.stringify(query)).toThrow();
		}
	});

	it("asks the database for one extra row to detect another page", () => {
		expect(pageWindow({ limit: 10, offset: 20 })).toEqual({ take: 11, skip: 20 });
	});

	it("trims the extra row and reports hasMore", () => {
		const more = toPage([1, 2, 3], { limit: 2, offset: 0 });
		expect(more).toEqual({ items: [1, 2], page: { limit: 2, offset: 0, hasMore: true } });
		const last = toPage([1, 2], { limit: 2, offset: 4 });
		expect(last).toEqual({ items: [1, 2], page: { limit: 2, offset: 4, hasMore: false } });
	});
});
