import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { evaluateSast } from "../../domain/sast/evaluate.js";
import {
	buildSastArgv,
	type ParsedSast,
	parseSastOutput,
	type SastFinding,
	SastFindingSchema,
} from "../../domain/sast/parse.js";
import { type Failure, fail, ok, type Result } from "../../shared/result.js";
import { recordArtifacts } from "../planning/artifacts.js";
import type { PlanDeps } from "../planning/deps.js";
import { type CheckDeps, runAndRecordChecks } from "./record-check.js";

export const SAST_TIMEOUT_MS = 5 * 60 * 1000;
const BASELINE_PATH = "sast/baseline-v1.json";

export type SastPhase = "baseline" | "task" | "integration" | "delivery";
export type SastDeps = CheckDeps & PlanDeps;

export type SastOutcome =
	| { kind: "skipped"; reason: string }
	| { kind: "pass" }
	| { kind: "blocked"; detail: string }
	| { kind: "unavailable"; reason: string };

export type SastRequest = {
	runId: string;
	taskId: string | null;
	repoDir: string;
	cwdLabel: string;
	phase: SastPhase;
	sastScript: string | undefined;
};

const BaselineSchema = z.object({
	commitSha: z.string(),
	findings: z.array(SastFindingSchema),
});

const brief = (findings: readonly SastFinding[]) =>
	findings.map((f) => ({ rule: f.rule, file: f.file, severity: f.severity }));

const loadBaseline = (deps: SastDeps, runId: string): SastFinding[] | null => {
	const artifact = deps.storage.artifacts.latest(runId, "sast-baseline", runId);
	if (!artifact) return null;
	const read = deps.artifactStore.read(runId, artifact.path);
	if (!read.ok) return null;
	try {
		const parsed = BaselineSchema.safeParse(JSON.parse(read.value.toString("utf8")));
		return parsed.success ? parsed.data.findings : null;
	} catch {
		return null;
	}
};

const event = (
	deps: SastDeps,
	input: SastRequest,
	type: "sast.recorded" | "sast.warning",
	payload: Record<string, unknown>,
): void => {
	deps.storage.events.append({
		runId: input.runId,
		...(input.taskId === null ? {} : { taskId: input.taskId }),
		type,
		payload: { phase: input.phase, ...payload },
		now: deps.clock.now(),
	});
};

type Executed = { parsed: ParsedSast; checkId: string; commitSha: string };

const execute = async (
	deps: SastDeps,
	input: SastRequest,
	scriptPath: string,
): Promise<Result<Executed, Failure<string>>> => {
	const script = deps.factoryFiles.read(scriptPath);
	if (!script.ok) return script;
	const ran = await runAndRecordChecks(deps, {
		runId: input.runId,
		taskId: input.taskId,
		repoDir: input.repoDir,
		cwdLabel: input.cwdLabel,
		steps: [{ argv: buildSastArgv(script.value.content), env: {}, timeoutMs: SAST_TIMEOUT_MS }],
	});
	if (!ran.ok) return ran;
	const check = ran.value[0];
	if (!check) return fail("check_not_recorded", "The SAST scan produced no result");
	let text = "";
	try {
		text = readFileSync(join(deps.factoryHome, check.logPath), "utf8");
	} catch {
		text = "";
	}
	const parsed: ParsedSast =
		check.exitCode === 0
			? parseSastOutput(text)
			: { status: "unavailable", reason: `the SAST scanner exited with code ${check.exitCode}` };
	return ok({ parsed, checkId: check.id, commitSha: check.commitSha });
};

export const recordSastBaseline = async (
	deps: SastDeps,
	input: Omit<SastRequest, "phase" | "taskId" | "cwdLabel">,
): Promise<Result<void, Failure<string>>> => {
	if (!input.sastScript) return ok(undefined);
	if (deps.storage.artifacts.latest(input.runId, "sast-baseline", input.runId))
		return ok(undefined);
	const request: SastRequest = {
		...input,
		taskId: null,
		cwdLabel: "sast-baseline",
		phase: "baseline",
	};
	const head = deps.git.headSha(input.repoDir);
	if (!head.ok) return head;
	const executed = await execute(deps, request, input.sastScript);
	if (!executed.ok) return executed;
	const { parsed, checkId, commitSha } = executed.value;
	if (parsed.status === "unavailable") {
		event(deps, request, "sast.warning", {
			status: "unavailable",
			reason: parsed.reason,
			checkId,
			commitSha,
		});
		return ok(undefined);
	}
	const recorded = recordArtifacts(
		deps,
		input.runId,
		[
			{
				kind: "sast-baseline",
				subject: input.runId,
				version: 1,
				path: BASELINE_PATH,
				content: `${JSON.stringify({ commitSha: head.value, findings: parsed.findings }, null, 2)}\n`,
				producer: "engine",
			},
		],
		() => ok(undefined),
	);
	if (!recorded.ok) return recorded;
	event(deps, request, "sast.recorded", {
		status: "baseline",
		commitSha: head.value,
		checkId,
		acceptedBaseline: brief(parsed.findings),
		counts: { total: parsed.findings.length },
	});
	return ok(undefined);
};

export const runSastGate = async (
	deps: SastDeps,
	input: SastRequest,
): Promise<Result<SastOutcome, Failure<string>>> => {
	if (!input.sastScript) return ok({ kind: "skipped", reason: "the check policy defines no SAST" });
	const executed = await execute(deps, input, input.sastScript);
	if (!executed.ok) return executed;
	const { parsed, checkId, commitSha } = executed.value;
	const verdict = evaluateSast(parsed, loadBaseline(deps, input.runId));
	const base = { checkId, commitSha };
	if (verdict.status === "unavailable") {
		event(deps, input, "sast.recorded", { ...base, status: "unavailable", reason: verdict.reason });
		if (input.phase === "task") {
			event(deps, input, "sast.warning", { ...base, reason: verdict.reason });
		}
		return ok({ kind: "unavailable", reason: verdict.reason });
	}
	event(deps, input, "sast.recorded", {
		...base,
		status: verdict.status,
		counts: verdict.counts,
		newSevere: brief(verdict.newSevere),
		newOther: brief(verdict.newOther),
		acceptedBaseline: brief(verdict.acceptedBaseline),
	});
	if (verdict.status === "pass") return ok({ kind: "pass" });
	const list = verdict.newSevere.map((f) => `${f.rule} ${f.file}:${f.line}`).join(", ");
	return ok({
		kind: "blocked",
		detail: `New high-severity SAST findings not in the baseline: ${list}`,
	});
};
