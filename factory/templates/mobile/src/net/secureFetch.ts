export type SecureFetchError =
	| "malformed_url"
	| "insecure_scheme"
	| "host_not_allowed"
	| "insecure_redirect"
	| "network_error";

export type SecureFetchResult =
	| { ok: true; value: Response }
	| { ok: false; error: SecureFetchError };

export interface SecureFetchPolicy {
	allowedHosts: readonly string[];
	allowLocalCleartext?: boolean;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const LOCAL_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "10.0.2.2"];
const URL_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#:@]*)(?::\d+)?(?:[/?#]|$)/;

interface ParsedTarget {
	scheme: string;
	host: string;
}

const parseTarget = (url: string): ParsedTarget | null => {
	const match = URL_PATTERN.exec(url.trim());
	if (match === null) return null;
	const [, scheme = "", host = ""] = match;
	return host === "" ? null : { scheme: scheme.toLowerCase(), host: host.toLowerCase() };
};

const isCleartextAllowed = (target: ParsedTarget, policy: SecureFetchPolicy): boolean =>
	policy.allowLocalCleartext === true && LOCAL_HOSTS.includes(target.host);

const checkTarget = (url: string, policy: SecureFetchPolicy): SecureFetchError | null => {
	const target = parseTarget(url);
	if (target === null) return "malformed_url";
	if (
		target.scheme !== "https" &&
		!(target.scheme === "http" && isCleartextAllowed(target, policy))
	)
		return "insecure_scheme";
	return policy.allowedHosts.includes(target.host) || isCleartextAllowed(target, policy)
		? null
		: "host_not_allowed";
};

export const createSecureFetch =
	(fetchImpl: FetchLike, policy: SecureFetchPolicy) =>
	async (url: string, init?: RequestInit): Promise<SecureFetchResult> => {
		const rejected = checkTarget(url, policy);
		if (rejected !== null) return { ok: false, error: rejected };
		try {
			const response = await fetchImpl(url, init);
			const finalUrl = typeof response.url === "string" ? response.url : "";
			if (finalUrl !== "" && checkTarget(finalUrl, policy) !== null)
				return { ok: false, error: "insecure_redirect" };
			return { ok: true, value: response };
		} catch {
			return { ok: false, error: "network_error" };
		}
	};
