import type request from "supertest";
import { buildProduct, type ProductAppOverrides } from "../src/composition.js";

export const OPEN_LIMITS = { max: 100_000, authMax: 100_000 };

export const buildTestProduct = (overrides: ProductAppOverrides = {}) =>
	buildProduct({ ...overrides, rateLimit: { ...OPEN_LIMITS, ...overrides.rateLimit } });

export const PASSWORD = "correct horse battery staple";

export const credentials = (email = "Ada@Example.com") => ({ email, password: PASSWORD });

export const refreshCookieOf = (response: request.Response): string => {
	const header = response.headers["set-cookie"];
	const cookies = Array.isArray(header) ? header : [];
	const cookie = cookies.find((entry) => entry.startsWith("refresh_token="));
	if (cookie === undefined) throw new Error("refresh_token cookie not set");
	return cookie;
};

export const cookiePair = (setCookie: string): string => setCookie.split(";")[0] ?? "";
