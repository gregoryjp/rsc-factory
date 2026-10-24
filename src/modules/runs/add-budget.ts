import { type Failure, fail, ok, type Result } from "../../shared/result.js";
import type { AppDeps } from "../deps.js";
import { currentBlock, unblockRun } from "./block-run.js";

export const addBudget = (
	deps: AppDeps,
	input: { runId: string; addUsd: number },
): Result<{ budgetUsd: number; unblocked: boolean; state: string }, Failure<string>> => {
	const { storage, clock } = deps;
	const run = storage.runs.get(input.runId);
	if (!run) return fail("run_not_found", `Run ${input.runId} not found`);
	if (!Number.isFinite(input.addUsd) || input.addUsd <= 0) {
		return fail("invalid_amount", "The amount to add must be a positive number of USD");
	}
	if (run.state === "SUCCEEDED" || run.state === "FAILED" || run.state === "CANCELED") {
		return fail("run_terminal", `Run ${run.id} is ${run.state}`);
	}
	const budgetUsd = Math.round((storage.budgets.limit(run.id) + input.addUsd) * 1e6) / 1e6;
	const done = storage.transaction<{ unblocked: boolean }, Failure<string>>(() => {
		storage.budgets.setLimit(run.id, budgetUsd);
		storage.events.append({
			runId: run.id,
			type: "budget.added",
			payload: { addedUsd: input.addUsd, budgetUsd },
			now: clock.now(),
		});
		const block = currentBlock(storage, run.id);
		if (block?.cause !== "budget_exhausted" && block?.cause !== "quota_wait") {
			return ok({ unblocked: false });
		}
		const moved = unblockRun(deps, run.id);
		return moved.ok ? ok({ unblocked: true }) : moved;
	});
	if (!done.ok) return done;
	return ok({
		budgetUsd,
		unblocked: done.value.unblocked,
		state: storage.runs.get(run.id)?.state ?? run.state,
	});
};
