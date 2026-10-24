import type { Run } from "../contracts/entities.js";
import { type RunState, RunStateSchema } from "../contracts/states.js";
import { type Failure, fail, ok, type Result } from "../shared/result.js";

const RESUMABLE_FROM_BLOCKED = [
	"INGESTING",
	"SPECIFYING",
	"PLANNING",
	"BUILDING",
	"VERIFYING",
	"REVIEWING",
	"REPAIRING",
	"INTEGRATING",
	"READY_FOR_RELEASE",
	"RELEASING",
] as const satisfies readonly RunState[];

export const RUN_TRANSITIONS: Record<RunState, readonly RunState[]> = {
	CREATED: ["INGESTING", "BLOCKED", "FAILED", "CANCELED"],
	INGESTING: ["SPECIFYING", "BLOCKED", "FAILED", "CANCELED"],
	SPECIFYING: ["PLANNING", "BLOCKED", "FAILED", "CANCELED"],
	PLANNING: ["BUILDING", "BLOCKED", "FAILED", "CANCELED"],
	BUILDING: ["VERIFYING", "BLOCKED", "FAILED", "CANCELED"],
	VERIFYING: ["REVIEWING", "REPAIRING", "BLOCKED", "FAILED", "CANCELED"],
	REVIEWING: ["REPAIRING", "INTEGRATING", "BLOCKED", "FAILED", "CANCELED"],
	REPAIRING: ["VERIFYING", "BLOCKED", "FAILED", "CANCELED"],
	INTEGRATING: ["READY_FOR_RELEASE", "REPAIRING", "BLOCKED", "FAILED", "CANCELED"],
	READY_FOR_RELEASE: ["RELEASING", "SUCCEEDED", "BLOCKED", "FAILED", "CANCELED"],
	RELEASING: ["SUCCEEDED", "BLOCKED", "FAILED", "CANCELED"],
	BLOCKED: [...RESUMABLE_FROM_BLOCKED, "FAILED", "CANCELED"],
	SUCCEEDED: [],
	FAILED: [],
	CANCELED: [],
};

export const isTerminalRun = (state: RunState): boolean => RUN_TRANSITIONS[state].length === 0;

export const TERMINAL_RUN_STATES: readonly RunState[] =
	RunStateSchema.options.filter(isTerminalRun);

export type RunTransitionError = Failure<"invalid_transition" | "delivery_target_required">;

export const transitionRun = (
	run: Pick<Run, "state" | "deliveryTarget">,
	to: RunState,
): Result<RunState, RunTransitionError> => {
	if (!RUN_TRANSITIONS[run.state].includes(to)) {
		return fail("invalid_transition", `Run cannot move from ${run.state} to ${to}`);
	}
	if (to === "SUCCEEDED" && run.deliveryTarget === null) {
		return fail("delivery_target_required", "A run needs a declared deliveryTarget to succeed");
	}
	return ok(to);
};
