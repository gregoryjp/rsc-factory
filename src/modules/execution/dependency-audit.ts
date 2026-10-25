import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { evaluateAudit } from "../../domain/depaudit/evaluate.js";
import { hasLockedDependencies } from "../../domain/depaudit/lockfile.js";
import {
	type Advisory,
	AdvisorySeveritySchema,
	type ParsedAudit,
	parseNpmAudit,
} from "../../domain/depaudit/parse.js";
import { type Failure, fail, ok, type Result } from "../../shared/result.js";
import { recordArtifacts } from "../planning/artifacts.js";
import type { PlanDeps } from "../planning/deps.js";
import { type CheckDeps, runAndRecordChecks } from "./record-check.js";

export const AUDIT_TIMEOUT_MS = 5 * 60 * 1000;
const LOCKFILE = "package-lock.json";
const BASELINE_PATH = "audit/baseline-v1.json";

export type AuditPhase = "baseline" | "task" | "integration" | "delivery";
export type AuditDeps = CheckDeps & PlanDeps;

export type AuditOutcome =
	| { kind: "skipped"; reason: string }
	| { kind: "pass" }
	| { kind: "blocked"; detail: string }
	| { kind: "unavailable"; reason: string };

export type AuditRequest = {
	runId: string;
	taskId: string | null;
	repoDir: string;
	cwdLabel: string;
	phase: AuditPhase;
	auditArgv: readonly string[] | undefined;
};

const BaselineSchema = z.object({
	commitSha: z.string(),
	status: z.enum(["recorded", "skipped"]),
	advisories: z.array(
		z.object({
			id: z.string(),
			package: z.string(),
			severity: AdvisorySeveritySchema,
			fixAvailable: z.boolean(),
		}),
	),
});

const brief = (advisories: readonly Advisory[]) =>
	advisories.map((a) => ({ id: a.id, package: a.package, severity: a.severity }));

const loadBaseline = (deps: AuditDeps, runId: string): Advisory[] | null => {
	const artifact = deps.storage.artifacts.latest(runId, "audit-baseline", runId);
	if (!artifact) return null;
	const read = deps.artifactStore.read(runId, artifact.path);
	if (!read.ok) return null;
	try {
		const parsed = BaselineSchema.safeParse(JSON.parse(read.value.toString("utf8")));
		return parsed.success ? parsed.data.advisories : null;
	} catch {
		return null;
	}
};

const event = (
	deps: AuditDeps,
	input: AuditRequest,
	type: "depaudit.recorded" | "depaudit.warning",
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

const skipped = (deps: AuditDeps, input: AuditRequest, reason: string): AuditOutcome => {
	event(deps, input, "depaudit.recorded", { status: "skipped", reason });
	return { kind: "skipped", reason };
};

type Executed = { parsed: ParsedAudit; checkId: string; commitSha: string };

const execute = async (
	deps: AuditDeps,
	input: AuditRequest,
	argv: readonly string[],
): Promise<Result<Executed, Failure<string>>> => {
	const ran = await runAndRecordChecks(deps, {
		runId: input.runId,
		taskId: input.taskId,
		repoDir: input.repoDir,
		cwdLabel: input.cwdLabel,
		steps: [{ argv, env: {}, timeoutMs: AUDIT_TIMEOUT_MS }],
	});
	if (!ran.ok) return ran;
	const check = ran.value[0];
	if (!check) return fail("check_not_recorded", "The audit produced no result");
	let text = "";
	try {
		text = readFileSync(join(deps.factoryHome, check.logPath), "utf8");
	} catch {
		text = "";
	}
	return ok({ parsed: parseNpmAudit(text), checkId: check.id, commitSha: check.commitSha });
};

const lockedDependencies = (
	deps: AuditDeps,
	input: AuditRequest,
): Result<boolean, Failure<string>> => {
	const head = deps.git.headSha(input.repoDir);
	if (!head.ok) return head;
	const lock = deps.git.showFile(input.repoDir, head.value, LOCKFILE);
	return ok(lock.ok && hasLockedDependencies(lock.value));
};

export const recordAuditBaseline = async (
	deps: AuditDeps,
	input: Omit<AuditRequest, "phase" | "taskId" | "cwdLabel">,
): Promise<Result<void, Failure<string>>> => {
	if (!input.auditArgv) return ok(undefined);
	if (deps.storage.artifacts.latest(input.runId, "audit-baseline", input.runId))
		return ok(undefined);
	const request: AuditRequest = {
		...input,
		taskId: null,
		cwdLabel: "audit-baseline",
		phase: "baseline",
	};
	const locked = lockedDependencies(deps, request);
	if (!locked.ok) return locked;
	const head = deps.git.headSha(input.repoDir);
	if (!head.ok) return head;
	let status: "recorded" | "skipped" = "skipped";
	let advisories: Advisory[] = [];
	let checkId: string | null = null;
	if (locked.value) {
		const executed = await execute(deps, request, input.auditArgv);
		if (!executed.ok) return executed;
		if (executed.value.parsed.status === "unavailable") {
			event(deps, request, "depaudit.warning", {
				status: "unavailable",
				reason: executed.value.parsed.reason,
				checkId: executed.value.checkId,
				commitSha: executed.value.commitSha,
			});
			return ok(undefined);
		}
		status = "recorded";
		advisories = executed.value.parsed.advisories;
		checkId = executed.value.checkId;
	}
	const recorded = recordArtifacts(
		deps,
		input.runId,
		[
			{
				kind: "audit-baseline",
				subject: input.runId,
				version: 1,
				path: BASELINE_PATH,
				content: `${JSON.stringify({ commitSha: head.value, status, advisories }, null, 2)}\n`,
				producer: "engine",
			},
		],
		() => ok(undefined),
	);
	if (!recorded.ok) return recorded;
	event(deps, request, "depaudit.recorded", {
		status: "baseline",
		commitSha: head.value,
		checkId,
		acceptedBaseline: brief(advisories),
		counts: { total: advisories.length },
	});
	return ok(undefined);
};

export const runDependencyAudit = async (
	deps: AuditDeps,
	input: AuditRequest,
): Promise<Result<AuditOutcome, Failure<string>>> => {
	if (!input.auditArgv) return ok({ kind: "skipped", reason: "the check policy defines no audit" });
	const locked = lockedDependencies(deps, input);
	if (!locked.ok) return locked;
	if (!locked.value) return ok(skipped(deps, input, "no locked dependencies"));
	const executed = await execute(deps, input, input.auditArgv);
	if (!executed.ok) return executed;
	const { parsed, checkId, commitSha } = executed.value;
	const verdict = evaluateAudit(parsed, loadBaseline(deps, input.runId));
	const base = { checkId, commitSha };
	if (verdict.status === "unavailable") {
		event(deps, input, "depaudit.recorded", {
			...base,
			status: "unavailable",
			reason: verdict.reason,
		});
		if (input.phase === "task") {
			event(deps, input, "depaudit.warning", { ...base, reason: verdict.reason });
		}
		return ok({ kind: "unavailable", reason: verdict.reason });
	}
	event(deps, input, "depaudit.recorded", {
		...base,
		status: verdict.status === "pass" ? "pass" : "new_vulnerability",
		counts: verdict.counts,
		newSevere: brief(verdict.newSevere),
		newOther: brief(verdict.newOther),
		acceptedBaseline: brief(verdict.acceptedBaseline),
	});
	if (verdict.status === "pass") return ok({ kind: "pass" });
	const list = verdict.newSevere.map((a) => `${a.package} ${a.id} (${a.severity})`).join(", ");
	return ok({
		kind: "blocked",
		detail: `New high/critical advisories not in the baseline: ${list}`,
	});
};
