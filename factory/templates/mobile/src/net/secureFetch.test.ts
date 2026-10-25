import { describe, expect, it, vi } from "vitest";
import { createSecureFetch, type FetchLike } from "./secureFetch";

const respond = (url: string): Response => ({ url, ok: true, status: 200 }) as Response;

const policy = { allowedHosts: ["api.example.com"] };

describe("createSecureFetch", () => {
	it("calls fetch for an https url on an allowed host", async () => {
		const fetchImpl = vi.fn<FetchLike>(async (input) => respond(input));
		const result = await createSecureFetch(fetchImpl, policy)("https://api.example.com:8443/v1/me");
		expect(result.ok).toBe(true);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it.each([
		["http://api.example.com/v1", "insecure_scheme"],
		["ftp://api.example.com/v1", "insecure_scheme"],
		["https://evil.example.net/v1", "host_not_allowed"],
		["https://api.example.com.evil.net/v1", "host_not_allowed"],
		["https://user@evil.example.net@api.example.com/", "malformed_url"],
		["//api.example.com/v1", "malformed_url"],
		["not a url", "malformed_url"],
		["https:///v1", "malformed_url"],
	])("rejects %s without calling fetch", async (url, error) => {
		const fetchImpl = vi.fn<FetchLike>(async (input) => respond(input));
		const result = await createSecureFetch(fetchImpl, policy)(url);
		expect(result).toEqual({ ok: false, error });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("allows cleartext only to local hosts and only when the policy opts in", async () => {
		const fetchImpl = vi.fn<FetchLike>(async (input) => respond(input));
		const local = { ...policy, allowLocalCleartext: true };
		expect((await createSecureFetch(fetchImpl, local)("http://localhost:3000/health")).ok).toBe(
			true,
		);
		expect((await createSecureFetch(fetchImpl, local)("http://10.0.2.2:3000/health")).ok).toBe(
			true,
		);
		expect(await createSecureFetch(fetchImpl, local)("http://api.example.com/health")).toEqual({
			ok: false,
			error: "insecure_scheme",
		});
		expect(await createSecureFetch(fetchImpl, policy)("http://localhost:3000/health")).toEqual({
			ok: false,
			error: "insecure_scheme",
		});
	});

	it("rejects a response that was redirected to an insecure or foreign url", async () => {
		const redirected = vi.fn<FetchLike>(async () => respond("http://api.example.com/v1"));
		expect(await createSecureFetch(redirected, policy)("https://api.example.com/v1")).toEqual({
			ok: false,
			error: "insecure_redirect",
		});
		const foreign = vi.fn<FetchLike>(async () => respond("https://evil.example.net/v1"));
		expect(await createSecureFetch(foreign, policy)("https://api.example.com/v1")).toEqual({
			ok: false,
			error: "insecure_redirect",
		});
	});

	it("turns a rejected fetch into a network_error result instead of throwing", async () => {
		const failing = vi.fn<FetchLike>(async () => {
			throw new Error("offline");
		});
		expect(await createSecureFetch(failing, policy)("https://api.example.com/v1")).toEqual({
			ok: false,
			error: "network_error",
		});
	});
});
