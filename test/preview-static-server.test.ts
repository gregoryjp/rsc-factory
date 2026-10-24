import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "./helpers/env.js";

const SCRIPT = join(import.meta.dirname, "..", "factory", "preview", "static-server.mjs");

type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };

const closers: (() => void)[] = [];
afterEach(() => {
	for (const close of closers.splice(0)) close();
});

const listen = (server: Server): Promise<number> =>
	new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
	});

const startUpstream = async (delayMs = 0) => {
	const seen: Seen[] = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			seen.push({
				method: req.method ?? "",
				url: req.url ?? "",
				headers: req.headers,
				body: Buffer.concat(chunks).toString("utf8"),
			});
			setTimeout(() => {
				res.writeHead(201, {
					"content-type": "application/json",
					"set-cookie": ["sid=abc; HttpOnly", "theme=dark"],
				});
				res.end(JSON.stringify({ ok: true }));
			}, delayMs);
		});
	});
	const port = await listen(server);
	closers.push(() => server.close());
	return { port, seen };
};

const freePort = async (): Promise<number> => {
	const probe = createServer();
	const port = await listen(probe);
	await new Promise((done) => probe.close(done));
	return port;
};

const startStatic = async (env: Record<string, string>) => {
	const root = makeTempDir();
	mkdirSync(join(root, "assets"), { recursive: true });
	writeFileSync(join(root, "index.html"), "<h1>home</h1>");
	const port = await freePort();
	const child: ChildProcess = spawn(process.execPath, [SCRIPT, root, String(port)], {
		env: { PATH: process.env.PATH ?? "", ...env },
		stdio: "ignore",
	});
	closers.push(() => child.kill());
	for (let attempt = 0; attempt < 50; attempt += 1) {
		try {
			await fetch(`http://127.0.0.1:${port}/`);
			return `http://127.0.0.1:${port}`;
		} catch {
			await new Promise((done) => setTimeout(done, 100));
		}
	}
	throw new Error("static server did not start");
};

describe("preview static server /api proxy", () => {
	it("serves the site and strips /api when forwarding to the one configured upstream", async () => {
		const upstream = await startUpstream();
		const base = await startStatic({ API_UPSTREAM: `http://127.0.0.1:${upstream.port}` });
		expect(await (await fetch(`${base}/`)).text()).toContain("home");
		const res = await fetch(`${base}/api/health/ready?x=1`);
		expect(res.status).toBe(201);
		expect(upstream.seen[0]?.url).toBe("/health/ready?x=1");
		expect(upstream.seen[0]?.headers.host).toBe(`127.0.0.1:${upstream.port}`);
	});

	it("preserves method, body, cookies and headers, and returns every set-cookie", async () => {
		const upstream = await startUpstream();
		const base = await startStatic({ API_UPSTREAM: `http://127.0.0.1:${upstream.port}` });
		const res = await fetch(`${base}/api/tickets`, {
			method: "POST",
			headers: { "content-type": "application/json", cookie: "sid=old", "x-custom": "yes" },
			body: JSON.stringify({ title: "hi" }),
		});
		expect(upstream.seen[0]).toMatchObject({
			method: "POST",
			url: "/tickets",
			body: '{"title":"hi"}',
		});
		expect(upstream.seen[0]?.headers.cookie).toBe("sid=old");
		expect(upstream.seen[0]?.headers["x-custom"]).toBe("yes");
		expect(res.headers.getSetCookie()).toEqual(["sid=abc; HttpOnly", "theme=dark"]);
	});

	it.each([["/api%2f..%2fsecret"], ["/api/%2e%2e%2fsecret"], ["/api/a%5cb"], ["/api/x%00y"]])(
		"refuses a path that could escape the proxy: %s",
		async (path) => {
			const upstream = await startUpstream();
			const base = await startStatic({ API_UPSTREAM: `http://127.0.0.1:${upstream.port}` });
			const res = await fetch(`${base}${path}`);
			expect([400, 404]).toContain(res.status);
			expect(upstream.seen).toHaveLength(0);
		},
	);

	it("does not treat /apix or dot-segment paths as the proxy", async () => {
		const upstream = await startUpstream();
		const base = await startStatic({ API_UPSTREAM: `http://127.0.0.1:${upstream.port}` });
		await fetch(`${base}/apix/a`);
		await fetch(`${base}/api/../index.html`);
		expect(upstream.seen).toHaveLength(0);
	});

	it("rejects bodies over the size limit", async () => {
		const upstream = await startUpstream();
		const base = await startStatic({ API_UPSTREAM: `http://127.0.0.1:${upstream.port}` });
		const res = await fetch(`${base}/api/big`, {
			method: "POST",
			body: "a".repeat(2 * 1024 * 1024),
		});
		expect(res.status).toBe(413);
		expect(upstream.seen).toHaveLength(0);
	});

	it("answers 504 when the upstream is too slow", async () => {
		const upstream = await startUpstream(1500);
		const base = await startStatic({
			API_UPSTREAM: `http://127.0.0.1:${upstream.port}`,
			PROXY_TIMEOUT_MS: "300",
		});
		expect((await fetch(`${base}/api/slow`)).status).toBe(504);
	});

	it("answers 502 when the upstream is unreachable", async () => {
		const dead = await freePort();
		const base = await startStatic({ API_UPSTREAM: `http://127.0.0.1:${dead}` });
		expect((await fetch(`${base}/api/x`)).status).toBe(502);
	});

	it("has no proxy at all without an upstream", async () => {
		const base = await startStatic({});
		expect((await fetch(`${base}/api/x`)).status).toBe(404);
	});

	it("ignores an absolute-form request target and only talks to the configured upstream", async () => {
		const upstream = await startUpstream();
		const base = await startStatic({ API_UPSTREAM: `http://127.0.0.1:${upstream.port}` });
		const target = new URL(base);
		await new Promise<void>((done) => {
			const req = httpRequest(
				{
					host: target.hostname,
					port: target.port,
					path: "http://evil.test/api/where",
					method: "GET",
				},
				(res) => {
					res.resume();
					res.on("end", done);
				},
			);
			req.end();
		});
		expect(upstream.seen[0]?.url).toBe("/where");
		expect(upstream.seen[0]?.headers.host).toBe(`127.0.0.1:${upstream.port}`);
	});
});
