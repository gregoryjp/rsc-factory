import { rmSync } from "node:fs";
import { join, relative } from "node:path";
import type { Check } from "../../contracts/entities.js";
import { type Failure, fail, ok, type Result } from "../../shared/result.js";
import type { AppDeps } from "../deps.js";
import { isRunCanceled } from "../runs/cancellation.js";
import type { CheckRunnerPort, GitPort, PreviewPort } from "./ports.js";

export type CheckDeps = AppDeps & {
	runner: CheckRunnerPort;
	git: GitPort;
	factoryHome: string;
	preview?: PreviewPort;
	signal?: AbortSignal;
};

export type CheckStep = {
	argv: readonly string[];
	env: Readonly<Record<string, string>>;
	timeoutMs: number;
};

export type ChecksInput = {
	runId: string;
	taskId: string | null;
	repoDir: string;
	cwdLabel: string;
	steps: readonly CheckStep[];
};

export type CheckInput = Omit<ChecksInput, "steps"> & CheckStep;

export type CheckError = Failure<string>;

const insertCheck = (
	deps: CheckDeps,
	check: Check,
	extra: { timedOut: boolean; killError: string | null },
): Result<Check, CheckError> =>
	deps.storage.transaction<Check, CheckError>(() => {
		deps.storage.checks.insert(check);
		deps.storage.events.append({
			runId: check.runId,
			...(check.taskId === null ? {} : { taskId: check.taskId }),
			type: "check.recorded",
			payload: {
				checkId: check.id,
				argv: check.argv,
				cwd: check.cwd,
				exitCode: check.exitCode,
				commitSha: check.commitSha,
				isolated: check.isolated,
				timedOut: extra.timedOut,
				killError: extra.killError,
			},
			now: check.createdAt,
		});
		return ok(check);
	});

export const runAndRecordChecks = async (
	deps: CheckDeps,
	input: ChecksInput,
): Promise<Result<Check[], CheckError>> => {
	const { git, runner, clock, ids } = deps;
	const head = git.headSha(input.repoDir);
	if (!head.ok) return head;
	const snapshotDir = join(deps.factoryHome, "runs", input.runId, "check-work", ids("snap"));
	const snapshot = git.snapshot(input.repoDir, head.value, snapshotDir);
	if (!snapshot.ok) {
		rmSync(snapshotDir, { recursive: true, force: true });
		return snapshot;
	}
	const recorded: Check[] = [];
	try {
		for (const step of input.steps) {
			if (isRunCanceled(deps, input.runId)) {
				return fail("run_canceled", "The run was canceled before the next check step");
			}
			const checkId = ids("chk");
			const outcome = await runner.runCheck({
				runId: input.runId,
				checkId,
				cwd: snapshotDir,
				argv: step.argv,
				env: step.env,
				timeoutMs: step.timeoutMs,
				...(deps.signal === undefined ? {} : { signal: deps.signal }),
			});
			if (!outcome.ok) return outcome;
			if (isRunCanceled(deps, input.runId)) {
				return fail("run_canceled", "The run was canceled while a check was running");
			}
			const stored = insertCheck(
				deps,
				{
					id: outcome.value.checkId,
					runId: input.runId,
					taskId: input.taskId,
					argv: [...step.argv],
					cwd: input.cwdLabel,
					exitCode: outcome.value.exitCode,
					durationMs: outcome.value.durationMs,
					commitSha: head.value,
					logPath: relative(deps.factoryHome, outcome.value.logPath),
					logSha256: outcome.value.logSha256,
					isolated: outcome.value.isolated,
					createdAt: clock.now(),
				},
				{ timedOut: outcome.value.timedOut, killError: outcome.value.killError },
			);
			if (!stored.ok) return stored;
			recorded.push(stored.value);
			if (outcome.value.exitCode !== 0) break;
		}
		return ok(recorded);
	} finally {
		rmSync(snapshotDir, { recursive: true, force: true });
	}
};

export const runAndRecordCheck = async (
	deps: CheckDeps,
	input: CheckInput,
): Promise<Result<Check, CheckError>> => {
	const { argv, env, timeoutMs, ...rest } = input;
	const result = await runAndRecordChecks(deps, { ...rest, steps: [{ argv, env, timeoutMs }] });
	if (!result.ok) return result;
	const first = result.value[0];
	return first ? ok(first) : fail("check_not_recorded", "The check produced no result");
};
