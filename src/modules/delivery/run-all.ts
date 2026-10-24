import { basename, resolve } from "node:path";
import type { RunState } from "../../contracts/states.js";
import { type Failure, fail, ok, type Result } from "../../shared/result.js";
import type { AppDeps } from "../deps.js";
import { type BuildRunDeps, type BuildStop, buildRun } from "../execution/build-run.js";
import { planRun } from "../planning/plan-run.js";
import { currentBlock, quotaWaitMessage } from "../runs/block-run.js";
import { getRunStatus } from "../runs/get-run-status.js";
import type { PrdFiles, TargetFiles } from "../runs/ports.js";
import { startRun } from "../runs/start-run.js";
import { type DeliverySummary, deliverRun } from "./deliver-run.js";

export type RunAllDeps = {
	start: AppDeps & { prdFiles: PrdFiles; targets: TargetFiles };
	prepare: (runId: string) => Promise<Result<BuildRunDeps, Failure<string>>>;
};

export type RunAllInput = {
	prdPath: string;
	targetPath: string;
	cwd: string;
	projectName?: string;
	budgetUsd?: number;
	maxProviderCalls?: number;
	maxTasks?: number;
	repairsPerTask: number;
	force?: boolean;
};

export type RunAllResult =
	| "delivered"
	| "paused_budget"
	| "paused_quota"
	| "paused_limit"
	| "blocked"
	| "failed"
	| "canceled";

export type RunAllOutcome = {
	runId: string;
	reused: boolean;
	state: RunState;
	result: RunAllResult;
	phases: string[];
	providerCalls: number;
	nextCommand: string | null;
	message: string;
	delivery: DeliverySummary | null;
};

type Phase = "plan" | "build" | "deliver";

const PHASE_OF_STATE: Partial<Record<RunState, Phase>> = {
	CREATED: "plan",
	INGESTING: "plan",
	SPECIFYING: "plan",
	PLANNING: "build",
	BUILDING: "build",
	READY_FOR_RELEASE: "deliver",
};

const TERMINAL_RESULT: Partial<Record<RunState, RunAllResult>> = {
	SUCCEEDED: "delivered",
	FAILED: "failed",
	CANCELED: "canceled",
};

const MAX_STEPS = 12;

const quote = (value: string): string =>
	/^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

const rerunCommand = (input: RunAllInput): string =>
	[
		"factory run --prd",
		quote(input.prdPath),
		"--target",
		quote(input.targetPath),
		...(input.projectName === undefined ? [] : ["--project", quote(input.projectName)]),
	].join(" ");

type Stop = Pick<RunAllOutcome, "result" | "message" | "nextCommand">;
type Step = { stop: Stop } | { stop?: undefined };

const BUILD_STOPS: Record<
	BuildStop,
	(ctx: { runId: string; rerun: string; detail: string | null }) => Step
> = {
	run_complete: () => ({}),
	budget_exhausted: () => ({}),
	quota_wait: () => ({}),
	blocked_tasks: ({ runId }) => ({
		stop: {
			result: "blocked",
			message: "Some tasks are BLOCKED; inspect them and retry the retryable ones.",
			nextCommand: `factory status ${runId}`,
		},
	}),
	no_ready_tasks: ({ runId }) => ({
		stop: {
			result: "blocked",
			message: "No task is ready to build and the run is not complete.",
			nextCommand: `factory status ${runId}`,
		},
	}),
	final_check_failed: ({ runId }) => ({
		stop: {
			result: "blocked",
			message: "The final integration check failed; nothing was delivered.",
			nextCommand: `factory status ${runId}`,
		},
	}),
	max_tasks: ({ rerun }) => ({
		stop: {
			result: "paused_limit",
			message: "Stopped at --max-tasks; the run keeps its progress.",
			nextCommand: rerun,
		},
	}),
	max_provider_calls: ({ rerun }) => ({
		stop: {
			result: "paused_limit",
			message: "Stopped at --max-provider-calls; the run keeps its progress.",
			nextCommand: rerun,
		},
	}),
	provider_unavailable: ({ rerun, detail }) => ({
		stop: {
			result: "failed",
			message: `The provider is unavailable${detail === null ? "" : ` (${detail})`}; retry later.`,
			nextCommand: rerun,
		},
	}),
	run_canceled: () => ({
		stop: { result: "canceled", message: "The run was canceled.", nextCommand: null },
	}),
};

export const runAll = async (
	deps: RunAllDeps,
	input: RunAllInput,
): Promise<Result<RunAllOutcome, Failure<string>>> => {
	const { storage, clock } = deps.start;
	const rerun = rerunCommand(input);
	const phases: string[] = [];
	let providerCalls = 0;

	const prd = deps.start.prdFiles.read(input.prdPath);
	if (!prd.ok) return prd;
	const resolvedTarget = deps.start.targets.resolve(input.targetPath);
	const project = storage.projects.findByName(
		(input.projectName ?? basename(resolve(input.cwd))).trim(),
	);
	const latest = project && storage.runs.findLatestByInput(project.id, prd.value.hash);
	const doneAlready =
		latest?.state === "SUCCEEDED" &&
		resolvedTarget.ok &&
		latest.targetPath === resolvedTarget.value.path;

	if (!doneAlready) {
		const started = startRun(deps.start, {
			prdPath: input.prdPath,
			targetPath: input.targetPath,
			projectName: input.projectName,
			cwd: input.cwd,
			forceNew: false,
			deliveryTarget: null,
			...(input.budgetUsd === undefined ? {} : { budgetUsd: input.budgetUsd }),
		});
		if (!started.ok) return started;
		return drive(started.value.run.id, started.value.reused);
	}
	return drive(latest.id, true);

	async function drive(
		runId: string,
		reused: boolean,
	): Promise<Result<RunAllOutcome, Failure<string>>> {
		const outcome = (
			stop: Stop,
			delivery: DeliverySummary | null = null,
		): Result<RunAllOutcome, never> =>
			ok({
				runId,
				reused,
				state: storage.runs.get(runId)?.state ?? "CREATED",
				phases,
				providerCalls,
				delivery,
				...stop,
			});
		for (let step = 0; step < MAX_STEPS; step += 1) {
			const run = storage.runs.get(runId);
			if (!run) return fail("run_not_found", `Run ${runId} not found`);
			let phase = PHASE_OF_STATE[run.state];
			if (run.state === "BLOCKED") {
				const block = currentBlock(storage, runId);
				if (block?.cause === "budget_exhausted") {
					return outcome({
						result: "paused_budget",
						message: block.nextStep ?? "The run budget is exhausted.",
						nextCommand: `factory budget ${runId} --add <usd>`,
					});
				}
				const waiting =
					block?.cause === "quota_wait" &&
					block.waitUntil !== null &&
					clock.now() < block.waitUntil &&
					input.force !== true;
				if (block?.cause === "quota_wait" && waiting) {
					return outcome({
						result: "paused_quota",
						message: quotaWaitMessage(block.waitUntil, clock.now()),
						nextCommand: rerun,
					});
				}
				phase = block?.cause === "quota_wait" ? PHASE_OF_STATE[block.priorState] : undefined;
				if (phase === undefined) {
					const status = getRunStatus(deps.start, { runId, eventLimit: 0 });
					return outcome({
						result: "blocked",
						message: status.ok ? status.value.nextStep : "The run is BLOCKED.",
						nextCommand: `factory status ${runId}`,
					});
				}
			}
			const terminal = TERMINAL_RESULT[run.state];
			if (terminal !== undefined && run.state !== "SUCCEEDED") {
				return outcome({
					result: terminal,
					message: `The run is ${run.state}.`,
					nextCommand: null,
				});
			}
			if (phase === undefined && run.state !== "SUCCEEDED") {
				return outcome({
					result: "blocked",
					message: `The run is in ${run.state}; run \`factory resume ${runId}\` and try again.`,
					nextCommand: `factory resume ${runId}`,
				});
			}
			const prepared = await deps.prepare(runId);
			if (!prepared.ok) return prepared;
			if (run.state === "SUCCEEDED" || phase === "deliver") {
				const delivered = await deliverRun(prepared.value, { runId });
				if (!delivered.ok) {
					return outcome({
						result: "failed",
						message: `Delivery failed [${delivered.error.code}]: ${delivered.error.message}`,
						nextCommand: `factory deliver ${runId}`,
					});
				}
				if (!delivered.value.alreadyDelivered) phases.push("deliver");
				return outcome(
					{
						result: "delivered",
						message: delivered.value.alreadyDelivered
							? "Already delivered; nothing to do."
							: "Delivered locally on main.",
						nextCommand: null,
					},
					delivered.value,
				);
			}
			if (phase === "plan") {
				const planned = await planRun(prepared.value, { runId, force: input.force === true });
				if (planned.ok) {
					phases.push("plan");
					providerCalls += planned.value.providerCalls;
					if (planned.value.state === "BLOCKED" && currentBlock(storage, runId) === undefined) {
						return outcome({
							result: "blocked",
							message: "Planning blocked the run (contradictions or an unmet gate).",
							nextCommand: `factory status ${runId}`,
						});
					}
					continue;
				}
				if (storage.runs.get(runId)?.state === "BLOCKED") continue;
				return outcome({
					result: "failed",
					message: `Planning failed [${planned.error.code}]: ${planned.error.message}`,
					nextCommand: rerun,
				});
			}
			const built = await buildRun(prepared.value, {
				runId,
				repairsPerTask: input.repairsPerTask,
				force: input.force === true,
				...(input.maxTasks === undefined ? {} : { maxTasks: input.maxTasks }),
				...(input.maxProviderCalls === undefined
					? {}
					: { maxProviderCalls: input.maxProviderCalls }),
			});
			if (!built.ok) {
				if (
					storage.runs.get(runId)?.state === "BLOCKED" &&
					currentBlock(storage, runId) !== undefined
				) {
					continue;
				}
				return outcome({
					result: "failed",
					message: `Build failed [${built.error.code}]: ${built.error.message}`,
					nextCommand: rerun,
				});
			}
			phases.push("build");
			providerCalls += built.value.providerCalls;
			const handled = BUILD_STOPS[built.value.stoppedBecause]({
				runId,
				rerun,
				detail: built.value.stopDetail,
			});
			if (handled.stop) {
				const blocked = built.value.blockedTasks.map((t) => `${t.key}: ${t.reason}`);
				return outcome({
					...handled.stop,
					message: [handled.stop.message, ...blocked].join(" "),
				});
			}
		}
		return outcome({
			result: "failed",
			message: "The orchestration made no progress; inspect the run.",
			nextCommand: `factory status ${runId}`,
		});
	}
};
