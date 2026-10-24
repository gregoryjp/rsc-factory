import type { Run } from "../../contracts/entities.js";
import type { RunState } from "../../contracts/states.js";
import {
	type RunTransitionError,
	transitionRun as validateTransition,
} from "../../domain/run-machine.js";
import { type Failure, fail, ok, type Result } from "../../shared/result.js";
import type { AppDeps } from "../deps.js";
import type { StorageFailure } from "../storage.js";
import type { VersionedUpdateError } from "./ports.js";

export type TransitionRunError =
	| Failure<"run_not_found">
	| RunTransitionError
	| VersionedUpdateError
	| StorageFailure;

export const transitionRun = (
	{ storage, clock }: AppDeps,
	input: { runId: string; to: RunState; reason?: string; details?: Record<string, unknown> },
): Result<Run, TransitionRunError> =>
	storage.transaction<Run, TransitionRunError>(() => {
		const run = storage.runs.get(input.runId);
		if (!run) return fail("run_not_found", `Run ${input.runId} not found`);
		const allowed = validateTransition(run, input.to);
		if (!allowed.ok) return allowed;
		const now = clock.now();
		const updated = storage.runs.updateState({
			id: run.id,
			expectedVersion: run.version,
			to: input.to,
			now,
		});
		if (!updated.ok) return updated;
		storage.events.append({
			runId: run.id,
			type: "run.state_changed",
			payload: {
				...input.details,
				from: run.state,
				to: input.to,
				...(input.reason === undefined ? {} : { reason: input.reason }),
			},
			now,
		});
		return ok(updated.value);
	});
