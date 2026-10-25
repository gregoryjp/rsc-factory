import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLifecycle } from "./lifecycle.js";
import { createShutdown } from "./shutdown.js";

const servers: Server[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.closeAllConnections();
});

const listen = async (): Promise<{
	server: Server;
	port: number;
	arrived: Promise<void>;
	release: () => void;
}> => {
	let arrive: () => void = () => {};
	let release: () => void = () => {};
	const arrived = new Promise<void>((resolve) => {
		arrive = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const app = express();
	app.get("/slow", async (_req, res) => {
		arrive();
		await gate;
		res.json({ done: true });
	});
	const server = createServer(app);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, port: (server.address() as AddressInfo).port, arrived, release };
};

const logger = { info: vi.fn(), error: vi.fn() };

describe("graceful shutdown", () => {
	it("lets an in-flight request finish, closes resources and exits 0", async () => {
		const { server, port, arrived, release } = await listen();
		const lifecycle = createLifecycle();
		const closeResources = vi.fn(async () => {});
		const exit = vi.fn();
		const shutdown = createShutdown({
			server,
			lifecycle,
			closeResources,
			logger,
			timeoutMs: 5000,
			exit,
		});
		const inflight = fetch(`http://127.0.0.1:${port}/slow`).then((r) => r.json());
		await arrived;
		const finished = shutdown("SIGTERM");
		expect(lifecycle.isShuttingDown()).toBe(true);
		expect(exit).not.toHaveBeenCalled();
		release();
		await finished;
		expect(await inflight).toEqual({ done: true });
		expect(lifecycle.isShuttingDown()).toBe(true);
		expect(closeResources).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledWith(0);
		await expect(fetch(`http://127.0.0.1:${port}/slow`)).rejects.toThrow();
	});

	it("is idempotent when signalled twice", async () => {
		const { server } = await listen();
		const closeResources = vi.fn(async () => {});
		const exit = vi.fn();
		const shutdown = createShutdown({
			server,
			lifecycle: createLifecycle(),
			closeResources,
			logger,
			timeoutMs: 1000,
			exit,
		});
		await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);
		expect(closeResources).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledTimes(1);
	});

	it("force-closes stuck connections after the timeout and exits 1", async () => {
		const { server, port, arrived } = await listen();
		const exit = vi.fn();
		const closeResources = vi.fn(async () => {});
		const shutdown = createShutdown({
			server,
			lifecycle: createLifecycle(),
			closeResources,
			logger,
			timeoutMs: 200,
			exit,
		});
		const stuck = fetch(`http://127.0.0.1:${port}/slow`).catch(() => "aborted");
		await arrived;
		await shutdown("SIGTERM");
		expect(await stuck).toBe("aborted");
		expect(closeResources).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledWith(1);
	});

	it("exits 1 when closing resources fails", async () => {
		const { server } = await listen();
		const exit = vi.fn();
		const shutdown = createShutdown({
			server,
			lifecycle: createLifecycle(),
			closeResources: async () => {
				throw new Error("disconnect failed");
			},
			logger,
			timeoutMs: 1000,
			exit,
		});
		await shutdown("SIGTERM");
		expect(exit).toHaveBeenCalledWith(1);
	});
});
