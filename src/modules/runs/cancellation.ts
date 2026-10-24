import type { AppDeps } from "../deps.js";

export const isRunCanceled = (
	deps: Pick<AppDeps, "storage"> & { signal?: AbortSignal },
	runId: string,
): boolean => deps.signal?.aborted === true || deps.storage.runs.get(runId)?.state === "CANCELED";
