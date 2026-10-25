import { describe, expect, it } from "vitest";
import { type DeepLinkPolicy, validateDeepLink } from "./validateDeepLink";

const policy: DeepLinkPolicy = {
	schemes: ["myapp", "https"],
	hosts: ["open", "app.example.com"],
	paths: ["/", "/settings", "/items"],
};

describe("validateDeepLink", () => {
	it.each([
		["myapp://open/settings", "/settings"],
		["myapp://open", "/"],
		["https://app.example.com/items/42?tab=1#top", "/items/42"],
		["MYAPP://OPEN/items", "/items"],
	])("accepts %s", (url, path) => {
		expect(validateDeepLink(url, policy)).toEqual({ ok: true, value: { path } });
	});

	it.each([
		["javascript:alert(1)", "scheme"],
		["data:text/html,hi", "scheme"],
		["file:///etc/passwd", "scheme"],
		["ftp://open/settings", "scheme"],
		["not a url", "malformed"],
		["", "malformed"],
		["myapp://evil.com/settings", "host"],
		["https://app.example.com.evil.com/items", "host"],
		["https://user@app.example.com/items", "host"],
		["myapp://open/admin", "path"],
		["myapp://open/settings/../admin", "traversal"],
		["myapp://open/items/%2e%2e/admin", "traversal"],
		["myapp://open/items/%252e%252e/admin", "traversal"],
		["myapp://open/items\\..\\admin", "traversal"],
		["myapp://open/items/%00", "traversal"],
	])("rejects %s with reason %s", (url, reason) => {
		const result = validateDeepLink(url, policy);
		expect(result).toEqual({ ok: false, error: reason });
	});

	it("matches paths on segment boundaries, not string prefixes", () => {
		expect(validateDeepLink("myapp://open/itemsX", policy)).toEqual({ ok: false, error: "path" });
		expect(validateDeepLink("myapp://open/items/1/2", policy).ok).toBe(true);
	});
});
