import type { Server } from "node:http";

const REQUEST_GRACE_MS = 5_000;
const HEADERS_TIMEOUT_MS = 15_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;

export const configureServerTimeouts = (
	server: Pick<Server, "requestTimeout" | "headersTimeout" | "keepAliveTimeout">,
	options: { requestTimeoutMs: number },
): void => {
	const requestTimeout = options.requestTimeoutMs + REQUEST_GRACE_MS;
	server.requestTimeout = requestTimeout;
	server.headersTimeout = Math.min(HEADERS_TIMEOUT_MS, requestTimeout);
	server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
};
