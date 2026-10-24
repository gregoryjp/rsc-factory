import type { RunState } from "../../contracts/states.js";
import { type Failure, fail, ok, type Result } from "../../shared/result.js";
import type { AppDeps } from "../deps.js";
import type { Storage } from "../storage.js";
import { transitionRun } from "./transition-run.js";

export type BlockCause = "budget_exhausted" | "quota_wait";

export type BlockInfo = {
	cause: string;
	priorState: RunState;
	waitUntil: number | null;
	nextStep: string | null;
	needUsd: number | null;
	remainingUsd: number | null;
	at: number;
};

const stringOr = (value: unknown): string | null => (typeof value === "string" ? value : null);
const numberOr = (value: unknown): number | null => (typeof value === "number" ? value : null);

export const currentBlock = (storage: Storage, runId: string): BlockInfo | undefined => {
	const run = storage.runs.get(runId);
	if (run?.state !== "BLOCKED") return undefined;
	const event = storage.events
		.list(runId, {})
		.findLast((e) => e.type === "run.state_changed" && e.payload.to === "BLOCKED");
	if (!event) return undefined;
	const p = event.payload;
	const prior = stringOr(p.priorState) ?? stringOr(p.from);
	return {
		cause: stringOr(p.cause) ?? stringOr(p.reason) ?? "unknown",
		priorState: (prior ?? "BUILDING") as RunState,
		waitUntil: numberOr(p.waitUntil),
		nextStep: stringOr(p.nextStep),
		needUsd: numberOr(p.needUsd),
		remainingUsd: numberOr(p.remainingUsd),
		at: event.timestamp,
	};
};

export const blockRun = (
	deps: AppDeps,
	input: {
		runId: string;
		cause: BlockCause;
		reason: string;
		nextStep: string;
		waitUntil?: number | null;
		needUsd?: number;
		remainingUsd?: number;
	},
): Result<void, Failure<string>> => {
	const run = deps.storage.runs.get(input.runId);
	if (!run) return fail("run_not_found", `Run ${input.runId} not found`);
	if (run.state === "BLOCKED") return ok(undefined);
	const moved = transitionRun(deps, {
		runId: input.runId,
		to: "BLOCKED",
		reason: input.reason,
		details: {
			cause: input.cause,
			priorState: run.state,
			nextStep: input.nextStep,
			...(input.waitUntil === undefined ? {} : { waitUntil: input.waitUntil }),
			...(input.needUsd === undefined ? {} : { needUsd: input.needUsd }),
			...(input.remainingUsd === undefined ? {} : { remainingUsd: input.remainingUsd }),
		},
	});
	return moved.ok ? ok(undefined) : moved;
};

export const unblockRun = (deps: AppDeps, runId: string): Result<RunState, Failure<string>> => {
	const block = currentBlock(deps.storage, runId);
	if (!block) return fail("not_blocked", `Run ${runId} is not blocked by a recorded cause`);
	const moved = transitionRun(deps, {
		runId,
		to: block.priorState,
		reason: `unblocked ${block.cause}`,
	});
	return moved.ok ? ok(block.priorState) : moved;
};

export const quotaWaitMessage = (waitUntil: number | null, now: number): string =>
	waitUntil === null
		? "Provider quota exhausted and the reset time is unknown; retry later or pass --force"
		: `Provider quota exhausted until ${new Date(waitUntil).toISOString()} (in ${Math.max(0, Math.ceil((waitUntil - now) / 60_000))} min); wait or pass --force`;

export const gateBlockedRun = (
	deps: AppDeps,
	input: { runId: string; force: boolean },
): Result<{ unblocked: boolean }, Failure<string>> => {
	const block = currentBlock(deps.storage, input.runId);
	if (!block) return ok({ unblocked: false });
	if (block.cause === "quota_wait") {
		const now = deps.clock.now();
		if (block.waitUntil !== null && now < block.waitUntil && !input.force) {
			return fail("quota_wait", quotaWaitMessage(block.waitUntil, now));
		}
		const moved = unblockRun(deps, input.runId);
		return moved.ok ? ok({ unblocked: true }) : moved;
	}
	if (block.cause === "budget_exhausted") {
		return fail(
			"budget_exhausted",
			block.nextStep ?? `Run budget exhausted; run \`factory budget ${input.runId} --add <usd>\``,
		);
	}
	return ok({ unblocked: false });
};
