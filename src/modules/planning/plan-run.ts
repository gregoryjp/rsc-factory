import { join } from "node:path";
import { z } from "zod";
import type { Run } from "../../contracts/entities.js";
import {
	type ArchitectOutput,
	ArchitectOutputSchema,
	type Artifact,
	type PlanArtifact,
	PlanArtifactSchema,
	PlannerOutputSchema,
	type SpecOutput,
	SpecOutputSchema,
} from "../../contracts/planning.js";
import { blockedTaskReasons, mustRequirementsAllBlocked } from "../../domain/planning/blocking.js";
import { validateArchitecture, validatePlan, validateSpec } from "../../domain/planning/gates.js";
import { renderDecisionMarkdown, renderSpecMarkdown } from "../../domain/planning/render.js";
import { extractDeclaredReqIds, findUnparsedReqTokens } from "../../domain/planning/req-ids.js";
import { applyRiskFloor } from "../../domain/planning/risk.js";
import { sha256Of } from "../../shared/hash.js";
import { err, fail, ok, type Result } from "../../shared/result.js";
import { reconcileStaleReservations, STALE_RESERVATION_MS } from "../budget/reconcile.js";
import { blockRun, gateBlockedRun } from "../runs/block-run.js";
import { transitionRun } from "../runs/transition-run.js";
import { seedTasks } from "../tasks/seed-tasks.js";
import { transitionTask } from "../tasks/transition-task.js";
import {
	ARCHITECTURE_PATH,
	adrPath,
	INGEST_PATH,
	PLAN_PATH,
	readVerified,
	recordArtifacts,
	specPaths,
} from "./artifacts.js";
import { type PlanDeps, type PlanError, providerModeOf } from "./deps.js";
import { architectPrompt, plannerPrompt, specPrompt } from "./prompts.js";
import { callRole } from "./run-role.js";
import { parseSpecFile, serializeSpecFile } from "./spec-files.js";

export type PlanPhase = "ingest" | "spec" | "architecture" | "plan" | "seed";

export type PlanSummary = {
	runId: string;
	state: Run["state"];
	ran: PlanPhase[];
	skipped: PlanPhase[];
	providerCalls: number;
	taskCount: number;
	blockedTaskCount: number;
	alreadyPlanned: boolean;
};

const SPEC_PRODUCER = "spec-writer";
const SPEC_V1 = 1;

const IngestFileSchema = z.strictObject({
	inputHash: z.string(),
	title: z.string(),
	bytes: z.number(),
	declaredReqIds: z.array(z.string()),
	ambiguousReqTokens: z.array(z.string()).default([]),
});

const ArchitectureFileSchema = z.strictObject({
	specVersion: z.number(),
	architecture: ArchitectOutputSchema,
});

const PLAN_PRODUCER = "planner";

const ROLE_ERROR_EFFECT: Record<string, "BLOCKED" | "FAILED" | undefined> = {
	role_rejected: "BLOCKED",
	provider_failed: "FAILED",
};

const parseJson = <S extends z.ZodType>(schema: S, content: string): z.infer<S> | undefined => {
	try {
		const parsed = schema.safeParse(JSON.parse(content));
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
};

const titleOf = (prd: string): string => {
	const heading = prd.split("\n").find((line) => /^#\s+\S/.test(line));
	return heading === undefined ? "Untitled" : heading.replace(/^#\s+/, "").trim();
};

type Context = {
	deps: PlanDeps;
	runId: string;
	runDir: string;
	ran: PlanPhase[];
	skipped: PlanPhase[];
};

const currentRun = (ctx: Context): Run | undefined => ctx.deps.storage.runs.get(ctx.runId);

const moveRun = (ctx: Context, to: Run["state"], reason?: string): Result<Run, PlanError> =>
	transitionRun(ctx.deps, { runId: ctx.runId, to, ...(reason === undefined ? {} : { reason }) });

const HALT_CODE = "plan_halted";

const haltPlan = (ctx: Context, role: string, error: PlanError): Result<never, PlanError> => {
	const quota = error.code === "quota_exhausted";
	const nextStep = quota
		? `Wait until the provider quota resets${error.waitUntil == null ? "" : ` (${new Date(error.waitUntil).toISOString()})`}, then run \`factory plan ${ctx.runId}\` again (or pass --force).`
		: `Run \`factory budget ${ctx.runId} --add <usd>\` (next ${role} call needs ${error.needUsd ?? "?"} USD, ${error.remainingUsd ?? "?"} USD remain), then run \`factory plan ${ctx.runId}\` again.`;
	const blocked = blockRun(ctx.deps, {
		runId: ctx.runId,
		cause: quota ? "quota_wait" : "budget_exhausted",
		reason: `${role}: ${error.message}`,
		nextStep,
		...(quota ? { waitUntil: error.waitUntil ?? null } : {}),
		...(error.needUsd === undefined ? {} : { needUsd: error.needUsd }),
		...(error.remainingUsd === undefined ? {} : { remainingUsd: error.remainingUsd }),
	});
	return blocked.ok
		? err({ code: HALT_CODE, message: nextStep })
		: err({ code: "state_transition_failed", message: blocked.error.message });
};

const applyRoleError = (ctx: Context, role: string, error: PlanError): Result<never, PlanError> => {
	if (error.code === "budget_exhausted" || error.code === "quota_exhausted") {
		return haltPlan(ctx, role, error);
	}
	const effect = ROLE_ERROR_EFFECT[error.code];
	if (effect === undefined) return err(error);
	const moved = moveRun(ctx, effect, `${role}: ${error.message}`);
	if (moved.ok) return err(error);
	return err({
		code: "state_transition_failed",
		message: `Could not move run to ${effect} after ${error.code} (${error.message}): ${moved.error.message}`,
		...(error.errors === undefined ? {} : { errors: error.errors }),
	});
};

const findVerified = (
	ctx: Context,
	kind: Artifact["kind"],
	version: number,
): Result<string | undefined, PlanError> => {
	const artifact = ctx.deps.storage.artifacts.find(ctx.runId, kind, "", version);
	if (!artifact) return ok(undefined);
	return readVerified(ctx.deps, artifact);
};

const ingestPhase = (ctx: Context, run: Run): Result<void, PlanError> => {
	const existing = findVerified(ctx, "ingest", 1);
	if (!existing.ok) return existing;
	if (existing.value === undefined) {
		const prd = ctx.deps.artifactStore.read(run.id, run.inputPath);
		if (!prd.ok) return prd;
		const text = prd.value.toString("utf8");
		const hash = sha256Of(prd.value);
		if (hash !== run.inputHash) {
			return fail("input_tampered", "The stored PRD copy does not match the recorded input hash");
		}
		const declaredReqIds = extractDeclaredReqIds(text);
		const ambiguousReqTokens = findUnparsedReqTokens(text, declaredReqIds);
		const recorded = recordArtifacts(
			ctx.deps,
			run.id,
			[
				{
					kind: "ingest",
					subject: "",
					version: 1,
					path: INGEST_PATH,
					producer: "engine",
					content: `${JSON.stringify(
						{
							inputHash: hash,
							title: titleOf(text),
							bytes: prd.value.byteLength,
							declaredReqIds,
							ambiguousReqTokens,
						},
						null,
						2,
					)}\n`,
				},
			],
			() => {
				if (ambiguousReqTokens.length > 0) {
					ctx.deps.storage.events.append({
						runId: run.id,
						type: "intake.req_ambiguous",
						payload: { tokens: ambiguousReqTokens, declared: declaredReqIds },
						now: ctx.deps.clock.now(),
					});
				}
				return ok(undefined);
			},
		);
		if (!recorded.ok) return recorded;
		ctx.ran.push("ingest");
	} else {
		ctx.skipped.push("ingest");
	}
	const moved = moveRun(ctx, "SPECIFYING");
	return moved.ok ? ok(undefined) : moved;
};

const loadIngest = (ctx: Context): Result<z.infer<typeof IngestFileSchema>, PlanError> => {
	const content = findVerified(ctx, "ingest", 1);
	if (!content.ok) return content;
	const parsed =
		content.value === undefined ? undefined : parseJson(IngestFileSchema, content.value);
	return parsed ? ok(parsed) : fail("artifact_corrupted", "Ingest artifact is missing or invalid");
};

const specPhase = async (ctx: Context, run: Run): Promise<Result<void, PlanError>> => {
	const existing = findVerified(ctx, "spec", SPEC_V1);
	if (!existing.ok) return existing;
	if (existing.value !== undefined) {
		ctx.skipped.push("spec");
		const moved = moveRun(ctx, "PLANNING");
		return moved.ok ? ok(undefined) : moved;
	}
	const ingest = loadIngest(ctx);
	if (!ingest.ok) return ingest;
	const prd = ctx.deps.artifactStore.read(run.id, run.inputPath);
	if (!prd.ok) return prd;
	const spec = await callRole(ctx.deps, {
		runId: run.id,
		role: "spec-writer",
		cwd: ctx.runDir,
		prompt: specPrompt(prd.value.toString("utf8"), ingest.value.declaredReqIds),
		schema: SpecOutputSchema,
		gate: (raw) => validateSpec(raw, ingest.value.declaredReqIds),
	});
	if (!spec.ok) return applyRoleError(ctx, "spec-writer", spec.error);
	const recorded = recordArtifacts(
		ctx.deps,
		run.id,
		[
			{
				kind: "spec",
				subject: "",
				version: SPEC_V1,
				path: specPaths(SPEC_V1).json,
				producer: SPEC_PRODUCER,
				content: serializeSpecFile({
					specVersion: SPEC_V1,
					inputHash: run.inputHash,
					spec: spec.value,
				}),
			},
			{
				kind: "spec-md",
				subject: "",
				version: SPEC_V1,
				path: specPaths(SPEC_V1).markdown,
				producer: "engine",
				content: renderSpecMarkdown(SPEC_V1, spec.value),
			},
		],
		() => {
			ctx.deps.storage.specs.insertSpec(run.id, SPEC_V1, spec.value);
			const moved = moveRun(ctx, "PLANNING");
			return moved.ok ? ok(undefined) : moved;
		},
	);
	if (!recorded.ok) return recorded;
	ctx.ran.push("spec");
	return ok(undefined);
};

const loadSpec = (ctx: Context): Result<{ spec: SpecOutput; version: number }, PlanError> => {
	const version = ctx.deps.storage.specs.latestVersion(ctx.runId);
	if (version === null) return fail("spec_missing", "Run has no recorded specification");
	const content = findVerified(ctx, "spec", version);
	if (!content.ok) return content;
	const file = content.value === undefined ? undefined : parseSpecFile(content.value);
	return file
		? ok({ spec: file.spec, version })
		: fail("artifact_corrupted", "Spec artifact is invalid");
};

const architecturePhase = async (
	ctx: Context,
	run: Run,
): Promise<Result<ArchitectOutput, PlanError>> => {
	const existing = findVerified(ctx, "architecture", 1);
	if (!existing.ok) return existing;
	if (existing.value !== undefined) {
		const parsed = parseJson(ArchitectureFileSchema, existing.value);
		if (!parsed) return fail("artifact_corrupted", "Architecture artifact is invalid");
		ctx.skipped.push("architecture");
		return ok(parsed.architecture);
	}
	const loaded = loadSpec(ctx);
	if (!loaded.ok) return loaded;
	const architecture = await callRole(ctx.deps, {
		runId: run.id,
		role: "architect",
		cwd: ctx.runDir,
		prompt: architectPrompt(loaded.value.spec),
		schema: ArchitectOutputSchema,
		gate: validateArchitecture,
	});
	if (!architecture.ok) return applyRoleError(ctx, "architect", architecture.error);
	const recorded = recordArtifacts(
		ctx.deps,
		run.id,
		[
			{
				kind: "architecture",
				subject: "",
				version: 1,
				path: ARCHITECTURE_PATH,
				producer: "architect",
				content: `${JSON.stringify({ specVersion: loaded.value.version, architecture: architecture.value }, null, 2)}\n`,
			},
			...architecture.value.decisions.map((decision) => ({
				kind: "adr" as const,
				subject: decision.id,
				version: 1,
				path: adrPath(decision.id),
				producer: "architect",
				content: renderDecisionMarkdown(decision),
			})),
		],
		() => {
			ctx.deps.storage.specs.insertDecisions(run.id, 1, architecture.value.decisions);
			ctx.deps.storage.runs.setPresets(run.id, architecture.value.presetIds);
			return ok(undefined);
		},
	);
	if (!recorded.ok) return recorded;
	ctx.ran.push("architecture");
	return ok(architecture.value);
};

const planPhase = async (
	ctx: Context,
	run: Run,
	architecture: ArchitectOutput,
): Promise<Result<PlanArtifact, PlanError>> => {
	const existing = findVerified(ctx, "plan", 1);
	if (!existing.ok) return existing;
	if (existing.value !== undefined) {
		const parsed = parseJson(PlanArtifactSchema, existing.value);
		if (!parsed) return fail("artifact_corrupted", "Plan artifact is invalid");
		ctx.skipped.push("plan");
		return ok(parsed);
	}
	const loaded = loadSpec(ctx);
	if (!loaded.ok) return loaded;
	const { spec, version } = loaded.value;
	const textById = new Map(spec.requirements.map((r) => [r.id, r.text]));
	const planned = await callRole(ctx.deps, {
		runId: run.id,
		role: "planner",
		cwd: ctx.runDir,
		prompt: plannerPrompt(spec, architecture),
		schema: PlannerOutputSchema,
		gate: (raw) => {
			const ordered = validatePlan(raw, spec);
			return ordered.ok
				? ok(
						ordered.value.map((task) =>
							applyRiskFloor(
								task,
								task.requirementIds.flatMap((id) => textById.get(id) ?? []),
							),
						),
					)
				: ordered;
		},
	});
	if (!planned.ok) return applyRoleError(ctx, "planner", planned.error);
	const plan: PlanArtifact = { planVersion: 1, specVersion: version, tasks: planned.value };
	const recorded = recordArtifacts(
		ctx.deps,
		run.id,
		[
			{
				kind: "plan",
				subject: "",
				version: 1,
				path: PLAN_PATH,
				producer: PLAN_PRODUCER,
				content: `${JSON.stringify(plan, null, 2)}\n`,
			},
		],
		() => ok(undefined),
	);
	if (!recorded.ok) return recorded;
	ctx.ran.push("plan");
	return ok(plan);
};

const seedPhase = (ctx: Context, run: Run, plan: PlanArtifact): Result<void, PlanError> => {
	const { deps } = ctx;
	if (deps.storage.tasks.listByRun(run.id).length > 0) {
		ctx.skipped.push("seed");
		return ok(undefined);
	}
	const rows = deps.storage.specs.getSpec(run.id, plan.specVersion);
	const reasons = blockedTaskReasons(plan.tasks, rows.contradictions);
	const result = deps.storage.transaction<void, PlanError>(() => {
		const seeded = seedTasks(deps, {
			runId: run.id,
			tasks: plan.tasks.map((task) => ({
				key: task.key,
				title: task.title,
				acceptance: task.acceptance.map((line) => `- ${line}`).join("\n"),
				dependsOn: task.dependsOn,
			})),
		});
		if (!seeded.ok) return seeded;
		deps.storage.taskMeta.insertMany(
			plan.tasks.map((task, index) => ({
				taskId: seeded.value[index]?.id ?? "",
				runId: run.id,
				key: task.key,
				requirementIds: task.requirementIds,
				risk: task.risk,
				modelRisk: task.modelRisk,
				riskReasons: task.riskReasons,
				expectedPaths: task.expectedPaths,
				blockedReason: reasons.get(task.key) ?? null,
			})),
		);
		for (const [index, task] of plan.tasks.entries()) {
			if (!reasons.has(task.key)) continue;
			const moved = transitionTask(deps, { taskId: seeded.value[index]?.id ?? "", to: "BLOCKED" });
			if (!moved.ok) return moved;
		}
		deps.storage.events.append({
			runId: run.id,
			type: "plan.seeded",
			payload: { taskCount: plan.tasks.length, blocked: Object.fromEntries(reasons) },
			now: deps.clock.now(),
		});
		if (mustRequirementsAllBlocked(rows.requirements, plan.tasks, new Set(reasons.keys()))) {
			const contradictionIds = rows.contradictions.filter((c) => c.critical).map((c) => c.id);
			const blocked = transitionRun(deps, {
				runId: run.id,
				to: "BLOCKED",
				reason: `Every must requirement is blocked by critical contradictions (${contradictionIds.join(", ")}); resolve them in the PRD and start a new run`,
			});
			if (!blocked.ok) return blocked;
		}
		return ok(undefined);
	});
	if (!result.ok) return result;
	ctx.ran.push("seed");
	return ok(undefined);
};

type Step = "continue" | "stop";
type Handler = (ctx: Context, run: Run) => Promise<Result<Step, PlanError>>;

const advance = (result: Result<unknown, PlanError>): Result<Step, PlanError> =>
	result.ok ? ok("continue") : result;

const planningPhases: Handler = async (ctx, run) => {
	const architecture = await architecturePhase(ctx, run);
	if (!architecture.ok) return architecture;
	const plan = await planPhase(ctx, run, architecture.value);
	if (!plan.ok) return plan;
	const seeded = seedPhase(ctx, run, plan.value);
	return seeded.ok ? ok("stop") : seeded;
};

const stop: Handler = async () => ok("stop");

const STATE_HANDLERS: Partial<Record<Run["state"], Handler>> = {
	CREATED: async (ctx) => advance(moveRun(ctx, "INGESTING")),
	INGESTING: async (ctx, run) => advance(ingestPhase(ctx, run)),
	SPECIFYING: async (ctx, run) => advance(await specPhase(ctx, run)),
	PLANNING: planningPhases,
	BLOCKED: async () => fail("run_blocked", "Run is BLOCKED; see `factory status` for the cause"),
	BUILDING: stop,
	VERIFYING: stop,
	REVIEWING: stop,
	REPAIRING: stop,
	INTEGRATING: stop,
	READY_FOR_RELEASE: stop,
	RELEASING: stop,
};

export const planRun = async (
	deps: PlanDeps,
	input: { runId: string; force?: boolean },
): Promise<Result<PlanSummary, PlanError>> => {
	const initial = deps.storage.runs.get(input.runId);
	if (!initial) return fail("run_not_found", `Run ${input.runId} not found`);
	if (initial.targetPath === null) {
		return fail("target_missing", `Run ${initial.id} has no target; start a new run with --target`);
	}
	if (initial.providerMode !== null && initial.providerMode !== providerModeOf(deps)) {
		return fail(
			"provider_mode_mismatch",
			`Run ${initial.id} started with the ${initial.providerMode} provider; refusing to continue with ${providerModeOf(deps)}`,
		);
	}
	for (const artifact of deps.storage.artifacts.list(initial.id)) {
		const verified = readVerified(deps, artifact);
		if (!verified.ok) return verified;
	}
	reconcileStaleReservations(deps, {
		runId: initial.id,
		staleAfterMs: STALE_RESERVATION_MS,
		now: deps.clock.now(),
	});
	const gated = gateBlockedRun(deps, { runId: initial.id, force: input.force === true });
	if (!gated.ok) return gated;
	const attemptsBefore = deps.storage.roleAttempts.list(initial.id).length;
	const ctx: Context = {
		deps,
		runId: initial.id,
		runDir: join(deps.settings.factoryHome, "runs", initial.id),
		ran: [],
		skipped: [],
	};
	for (;;) {
		const run = currentRun(ctx);
		if (!run) return fail("run_not_found", `Run ${input.runId} not found`);
		const handler = STATE_HANDLERS[run.state];
		if (!handler) return fail("run_terminal", `Run ${run.id} is ${run.state}`);
		const step = await handler(ctx, run);
		if (!step.ok) {
			if (step.error.code === HALT_CODE) break;
			return step;
		}
		if (step.value === "stop") break;
	}

	const finalRun = currentRun(ctx);
	if (!finalRun) return fail("run_not_found", `Run ${input.runId} not found`);
	const counts = deps.storage.tasks.countByState(finalRun.id);
	const total = Object.values(counts).reduce((a, b) => a + b, 0);
	return ok({
		runId: finalRun.id,
		state: finalRun.state,
		ran: ctx.ran,
		skipped: ctx.skipped,
		providerCalls: deps.storage.roleAttempts.list(finalRun.id).length - attemptsBefore,
		taskCount: total,
		blockedTaskCount: counts.BLOCKED,
		alreadyPlanned: ctx.ran.length === 0,
	});
};
