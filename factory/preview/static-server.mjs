import { createServer, request as httpRequest } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const port = Number(process.argv[3] ?? 4173);
const upstream = process.env.API_UPSTREAM ? new URL(process.env.API_UPSTREAM) : null;
const PROXY_TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS ?? 15_000);
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const API_PREFIX = "/api";
const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"host",
]);
const ESCAPING_PATH = /%2f|%5c|%00|\\|%2e%2e/i;

const TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".txt": "text/plain; charset=utf-8",
};

const isFile = async (path) => {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
};

const resolveFile = async (urlPath) => {
	const decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
	const candidate = normalize(join(root, decoded));
	if (candidate !== root && !candidate.startsWith(root + sep)) return null;
	if (await isFile(candidate)) return candidate;
	const index = join(candidate, "index.html");
	if (await isFile(index)) return index;
	if (extname(decoded) === "") {
		const fallback = join(root, "index.html");
		if (await isFile(fallback)) return fallback;
	}
	return null;
};

const plain = (res, status, text) => {
	if (res.headersSent) {
		res.destroy();
		return;
	}
	res.writeHead(status, { "content-type": "text/plain" });
	res.end(text);
};

const IN_API = /^\/api(?:$|[/%])/i;

const proxyTarget = (rawUrl) => {
	let parsed;
	try {
		parsed = new URL(rawUrl, "http://local.invalid");
	} catch {
		return "refused";
	}
	const path = parsed.pathname;
	if (!IN_API.test(path)) return null;
	if (upstream === null) return "missing";
	if (ESCAPING_PATH.test(path)) return "refused";
	if (path !== API_PREFIX && !path.startsWith(`${API_PREFIX}/`)) return "refused";
	const rest = path.slice(API_PREFIX.length);
	return `${rest === "" ? "/" : rest}${parsed.search}`;
};

const forward = (req, res, targetPath) => {
	const declared = Number(req.headers["content-length"] ?? 0);
	if (declared > MAX_REQUEST_BYTES) {
		plain(res, 413, "payload too large");
		req.resume();
		return;
	}
	const headers = Object.fromEntries(
		Object.entries(req.headers).filter(([name]) => !HOP_BY_HOP.has(name)),
	);
	headers.host = upstream.host;
	const out = httpRequest(
		{
			protocol: upstream.protocol,
			hostname: upstream.hostname,
			port: upstream.port,
			method: req.method,
			path: targetPath,
			headers,
			timeout: PROXY_TIMEOUT_MS,
		},
		(back) => {
			const passed = Object.fromEntries(
				Object.entries(back.headers).filter(([name]) => !HOP_BY_HOP.has(name)),
			);
			res.writeHead(back.statusCode ?? 502, passed);
			let total = 0;
			back.on("data", (chunk) => {
				total += chunk.length;
				if (total > MAX_RESPONSE_BYTES) {
					back.destroy();
					res.destroy();
					return;
				}
				res.write(chunk);
			});
			back.on("end", () => res.end());
			back.on("error", () => res.destroy());
		},
	);
	out.on("timeout", () => {
		plain(res, 504, "upstream timeout");
		out.destroy();
	});
	out.on("error", () => plain(res, 502, "bad gateway"));
	let sent = 0;
	req.on("data", (chunk) => {
		sent += chunk.length;
		if (sent > MAX_REQUEST_BYTES) {
			plain(res, 413, "payload too large");
			out.destroy();
			req.destroy();
			return;
		}
		out.write(chunk);
	});
	req.on("end", () => out.end());
	req.on("error", () => out.destroy());
};

createServer(async (req, res) => {
	try {
		const target = proxyTarget(req.url ?? "/");
		if (target === "refused") {
			plain(res, 400, "bad request");
			return;
		}
		if (target === "missing") {
			plain(res, 404, "not found");
			return;
		}
		if (target !== null) {
			forward(req, res, target);
			return;
		}
		const file = await resolveFile(req.url ?? "/");
		if (file === null) {
			plain(res, 404, "not found");
			return;
		}
		const body = await readFile(file);
		res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
		res.end(body);
	} catch {
		plain(res, 400, "bad request");
	}
}).listen(port, "0.0.0.0");
