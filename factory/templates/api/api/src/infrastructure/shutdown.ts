import type { Server } from "node:http";
import type { Lifecycle } from "./lifecycle.js";

const IDLE_SWEEP_MS = 100;

export type ShutdownDeps = {
	server: Pick<Server, "close" | "closeIdleConnections" | "closeAllConnections">;
	lifecycle: Lifecycle;
	closeResources: () => Promise<void>;
	logger: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
	timeoutMs: number;
	exit: (code: number) => void;
};

const waitFor = (promise: Promise<void>, timeoutMs: number): Promise<boolean> =>
	new Promise((resolve) => {
		const timer = setTimeout(() => resolve(true), timeoutMs);
		promise.then(() => {
			clearTimeout(timer);
			resolve(false);
		});
	});

const run = async (deps: ShutdownDeps, signal: string): Promise<void> => {
	deps.lifecycle.beginShutdown();
	deps.logger.info({ signal }, "shutting down");
	const drained = new Promise<void>((resolve) => deps.server.close(() => resolve()));
	const sweep = setInterval(() => deps.server.closeIdleConnections(), IDLE_SWEEP_MS);
	deps.server.closeIdleConnections();
	const timedOut = await waitFor(drained, deps.timeoutMs);
	clearInterval(sweep);
	if (timedOut) {
		deps.logger.error({ timeoutMs: deps.timeoutMs }, "drain timed out, closing connections");
		deps.server.closeAllConnections();
		await drained;
	}
	const closed = await deps
		.closeResources()
		.then(() => true)
		.catch((error: unknown) => {
			deps.logger.error({ err: error }, "closing resources failed");
			return false;
		});
	deps.exit(timedOut || !closed ? 1 : 0);
};

export const createShutdown = (deps: ShutdownDeps): ((signal: string) => Promise<void>) => {
	let started: Promise<void> | undefined;
	return (signal) => {
		started ??= run(deps, signal);
		return started;
	};
};
