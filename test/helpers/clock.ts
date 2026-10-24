import type { Clock } from "../../src/infrastructure/clock.js";

export type FakeClock = Clock & { advance: (ms: number) => void };

export const createFakeClock = (start = 1_700_000_000_000): FakeClock => {
	let current = start;
	return {
		now: () => current,
		advance: (ms) => {
			current += ms;
		},
	};
};
