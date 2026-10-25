export interface DeepLinkPolicy {
	schemes: readonly string[];
	hosts: readonly string[];
	paths: readonly string[];
}

export type DeepLinkError = "malformed" | "scheme" | "host" | "traversal" | "path";

export type DeepLinkResult =
	| { ok: true; value: { path: string } }
	| { ok: false; error: DeepLinkError };

const SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):([\s\S]*)$/;
const AUTHORITY_PATTERN = /^\/\/([^/?#]*)([^?#]*)/;
const UNSAFE_PATH = /(^|\/)\.{1,2}(\/|$)|\\/;

const hasControlChar = (value: string): boolean =>
	[...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

const decodeRepeatedly = (value: string): string | null => {
	let current = value;
	for (let round = 0; round < 3; round += 1) {
		try {
			const next = decodeURIComponent(current);
			if (next === current) return current;
			current = next;
		} catch {
			return null;
		}
	}
	return current.includes("%") ? null : current;
};

const matchesPath = (path: string, allowed: readonly string[]): boolean =>
	allowed.some((prefix) => path === prefix || (prefix !== "/" && path.startsWith(`${prefix}/`)));

export const validateDeepLink = (url: string, policy: DeepLinkPolicy): DeepLinkResult => {
	const schemeMatch = SCHEME_PATTERN.exec(url.trim());
	if (schemeMatch === null) return { ok: false, error: "malformed" };
	const [, scheme = "", rest = ""] = schemeMatch;
	if (!policy.schemes.includes(scheme.toLowerCase())) return { ok: false, error: "scheme" };
	const match = AUTHORITY_PATTERN.exec(rest);
	if (match === null) return { ok: false, error: "malformed" };
	const [, authority = "", rawPath = ""] = match;
	if (!policy.hosts.includes(authority.toLowerCase())) return { ok: false, error: "host" };
	const decoded = decodeRepeatedly(rawPath);
	if (decoded === null || UNSAFE_PATH.test(decoded) || hasControlChar(decoded))
		return { ok: false, error: "traversal" };
	const path = rawPath === "" ? "/" : rawPath;
	if (!matchesPath(path, policy.paths)) return { ok: false, error: "path" };
	return { ok: true, value: { path } };
};
