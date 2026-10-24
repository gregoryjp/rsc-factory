import type { z } from "zod";
import type { Role } from "../../contracts/planning.js";
import { backoffDelayMs } from "../../domain/provider/quota.js";
import type {
	ProviderFailure,
	ProviderRequest,
	ProviderSuccess,
} from "../../infrastructure/providers/provider-port.js";
import type { Result } from "../../shared/result.js";
import type { PlanDeps } from "../planning/deps.js";
import { isRunCanceled } from "../runs/cancellation.js";
import { loadBudgetConfig } from "./load-config.js";

export type Halt =
	| { kind: "budget_exhausted"; message: string; needUsd: number; remainingUsd: number }
	| { kind: "run_canceled"; message: string }
	| { kind: "budget_config_invalid"; message: string };

export type GuardedAttempt<T> = {
	attemptId: number;
	result: Result<ProviderSuccess<T>, ProviderFailure>;
};

export type GuardedCall<T> = { halted: Halt } | { halted?: undefined; attempt: GuardedAttempt<T> };

export type GuardedInput = {
	runId: string;
	role: Role;
	repair: boolean;
	model: string;
	promptFile: string;
	promptHash: string;
	request: Omit<ProviderRequest, "maxBudgetUsd" | "signal">;
	eventExtras?: Record<string, unknown>;
};

const RETRYABLE_ONCE = "timeout";
const TRANSIENT = "rate_limited_transient";

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

export const guardedInvoke = async <T>(
	deps: PlanDeps,
	input: GuardedInput,
	schema: z.ZodType<T>,
): Promise<GuardedCall<T>> => {
	const { storage, clock } = deps;
	const config = loadBudgetConfig(deps.factoryFiles);
	if (!config.ok) {
		return { halted: { kind: "budget_config_invalid", message: config.error.message } };
	}
	const { retry, maxCallUsd } = config.value;
	const ceiling = maxCallUsd[input.role];
	let timeoutsRetried = 0;

	for (let tryNumber = 1; ; tryNumber += 1) {
		if (isRunCanceled(deps, input.runId)) {
			return { halted: { kind: "run_canceled", message: "The run was canceled" } };
		}
		const reservation = storage.budgets.reserve({
			runId: input.runId,
			role: input.role,
			amountUsd: ceiling,
			now: clock.now(),
		});
		if (!reservation.ok) {
			return {
				halted: {
					kind: "budget_exhausted",
					message: reservation.error.message,
					needUsd: ceiling,
					remainingUsd: reservation.error.remainingUsd,
				},
			};
		}
		const attemptId = storage.roleAttempts.start({
			runId: input.runId,
			role: input.role,
			repair: input.repair,
			model: input.model,
			promptFile: input.promptFile,
			promptHash: input.promptHash,
			tryNumber,
			now: clock.now(),
		});
		storage.budgets.attach(reservation.value, attemptId);
		storage.events.append({
			runId: input.runId,
			type: "role.called",
			payload: {
				role: input.role,
				attemptId,
				repair: input.repair,
				tryNumber,
				model: input.model,
				promptHash: input.promptHash,
				provider: deps.settings.providerKind,
				reservedUsd: ceiling,
				...input.eventExtras,
			},
			now: clock.now(),
		});
		const result = await deps.provider.invoke(
			{
				...input.request,
				maxBudgetUsd: ceiling,
				...(deps.signal === undefined ? {} : { signal: deps.signal }),
			},
			schema,
		);
		const cost = result.ok ? result.value.costUsd : result.error.costUsd;
		storage.budgets.settle({
			reservationId: reservation.value,
			chargeUsd: cost ?? ceiling,
			basis: cost === null ? "unknown_reservation" : "reported",
			now: clock.now(),
		});
		if (result.ok) return { attempt: { attemptId, result } };

		const failure = result.error;
		const retryable =
			(failure.kind === TRANSIENT && tryNumber < retry.maxAttempts) ||
			(failure.kind === RETRYABLE_ONCE && timeoutsRetried < 1);
		if (!retryable || isRunCanceled(deps, input.runId)) {
			return { attempt: { attemptId, result } };
		}
		if (failure.kind === RETRYABLE_ONCE) timeoutsRetried += 1;
		storage.roleAttempts.finish(attemptId, {
			outcome: "provider_failed",
			costUsd: failure.costUsd,
			error: failure.message,
			failureClass: failure.kind,
			now: clock.now(),
		});
		const delayMs = backoffDelayMs(tryNumber, retry, deps.random ?? Math.random);
		storage.events.append({
			runId: input.runId,
			type: "provider.retry",
			payload: {
				role: input.role,
				attemptId,
				tryNumber,
				failureClass: failure.kind,
				delayMs,
			},
			now: clock.now(),
		});
		await (deps.sleep ?? defaultSleep)(delayMs);
	}
};
