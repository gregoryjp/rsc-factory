export type Lifecycle = { isShuttingDown: () => boolean; beginShutdown: () => void };

export const createLifecycle = (): Lifecycle => {
	let shuttingDown = false;
	return {
		isShuttingDown: () => shuttingDown,
		beginShutdown: () => {
			shuttingDown = true;
		},
	};
};
