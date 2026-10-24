export type HaltReason = "budget_exhausted" | "quota_wait" | "run_canceled";

export type StopInfo = { waitUntil?: number | null; needUsd?: number; remainingUsd?: number };

export const HALT_BY_ERROR_CODE: Record<string, HaltReason | undefined> = {
	budget_exhausted: "budget_exhausted",
	quota_exhausted: "quota_wait",
	run_canceled: "run_canceled",
};

export const stopInfoOf = (error: {
	waitUntil?: number | null;
	needUsd?: number;
	remainingUsd?: number;
}): StopInfo => ({
	...(error.waitUntil === undefined ? {} : { waitUntil: error.waitUntil }),
	...(error.needUsd === undefined ? {} : { needUsd: error.needUsd }),
	...(error.remainingUsd === undefined ? {} : { remainingUsd: error.remainingUsd }),
});
