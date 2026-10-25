import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Check } from "../../contracts/entities.js";
import { UiEvidenceSchema } from "../../contracts/ui-evidence.js";
import { isCheckPassed } from "../../domain/checks/evidence.js";
import { summarizeAudit } from "../../domain/depaudit/summary.js";
import { fallbacksOf } from "../../domain/provider/fallback.js";
import { releaseStatusOf } from "../../domain/release/status.js";
import { deliveryStateOf } from "../../domain/report/delivery-state.js";
import type {
	CheckRef,
	ReportDelivery,
	ReportRequirement,
	ReportReview,
	ReportTask,
	ReportUi,
	RunReport,
} from "../../domain/report/types.js";
import { type Failure, fail, ok, type Result } from "../../shared/result.js";
import type { AppDeps } from "../deps.js";
import type { StoredFinding, StoredReview } from "../execution/ports.js";
import type { TaskMeta } from "../planning/ports.js";
import { getRunStatus } from "../runs/get-run-status.js";

export type ReportDeps = Pick<AppDeps, "storage"> & { factoryHome: string };

export type ReportOptions = { preDelivery?: boolean };

export const FINAL_CHECK_CWD = "integration-final";
export const DELIVERY_CHECK_PREFIX = "delivery-";

const AREA_ORDER = ["security", "code", "legal", "ux", "ui"];
const SEVERITY_ORDER = ["critical", "high", "medium", "low"];
const SEVERE = new Set(["critical", "high"]);
const UI_EVIDENCE_FILE = "ui-evidence.json";

const PHASE_OF_ROLE: Record<string, "planning" | "build" | "review"> = {
	"spec-writer": "planning",
	architect: "planning",
	planner: "planning",
	builder: "build",
	"reviewer-security": "review",
	"reviewer-code": "review",
	"reviewer-ux": "review",
	"reviewer-ui": "review",
	"reviewer-legal": "review",
	"review-refuter": "review",
	approver: "review",
};

const PROVIDER_LABEL: Record<string, string> = { claude: "real", fake: "fake" };

const toRef = (check: Check): CheckRef => ({
	id: check.id,
	argv: check.argv,
	cwd: check.cwd,
	exitCode: check.exitCode,
	commitSha: check.commitSha,
	logPath: check.logPath,
	logSha256: check.logSha256,
	isolated: check.isolated,
});

const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort();

const readUiEvidence = (
	factoryHome: string,
	dir: string,
): { screenshots: string[]; authenticatedRoles: string[] } | undefined => {
	try {
		const raw: unknown = JSON.parse(readFileSync(join(factoryHome, dir, UI_EVIDENCE_FILE), "utf8"));
		const parsed = UiEvidenceSchema.safeParse(raw);
		if (!parsed.success) return undefined;
		const captured = parsed.data.pages.flatMap((page) =>
			page.status === "captured" ? [page] : [],
		);
		return {
			screenshots: sortedUnique(captured.map((page) => page.screenshot.path)),
			authenticatedRoles: sortedUnique(
				captured.flatMap((page) => (page.authenticated && page.as !== null ? [page.as] : [])),
			),
		};
	} catch {
		return undefined;
	}
};

const uiOf = (
	deps: ReportDeps,
	runId: string,
	taskId: string,
	reviews: readonly ReportReview[],
): ReportUi => {
	const event = deps.storage.events
		.list(runId, {})
		.findLast((e) => e.taskId === taskId && e.type === "task.ui_evidence");
	const p = event?.payload;
	if (p?.status === "captured" && typeof p.dir === "string") {
		const read = readUiEvidence(deps.factoryHome, p.dir);
		return {
			status: "captured",
			dir: p.dir,
			pages: Number(p.pages ?? 0),
			axeViolations: Number(p.axeViolations ?? 0),
			overflowPages: Number(p.overflowPages ?? 0),
			screenshots: read?.screenshots ?? [],
			authenticatedRoles: read?.authenticatedRoles ?? [],
		};
	}
	if (p?.status === "unavailable") {
		return { status: "unavailable", reason: String(p.reason ?? "unavailable") };
	}
	if (reviews.length === 0) return { status: "not_reviewed" };
	const applies = reviews.some(
		(review) =>
			(review.area === "ux" || review.area === "ui") && review.verdict !== "not_applicable",
	);
	return applies ? { status: "sin_evidencia" } : { status: "not_applicable" };
};

const latestPerArea = (reviews: readonly StoredReview[]): StoredReview[] =>
	AREA_ORDER.flatMap((area) => reviews.filter((review) => review.area === area).slice(-1));

const findingOf = (finding: StoredFinding) => ({
	uid: finding.uid,
	severity: finding.severity,
	status: finding.status,
	title: finding.title,
	file: finding.file,
	refutation: finding.refutation?.outcome ?? null,
});

const taskReport = (
	deps: ReportDeps,
	runId: string,
	meta: TaskMeta,
	checks: readonly Check[],
): ReportTask => {
	const { storage } = deps;
	const task = storage.tasks.get(meta.taskId);
	const build = storage.taskBuilds.get(meta.taskId);
	const cycle = storage.retries.count(meta.taskId);
	const stored = latestPerArea(storage.reviews.listReviews(meta.taskId, cycle));
	const head = storage.reviews.listReviews(meta.taskId, cycle).at(-1)?.commitSha;
	const findings = head === undefined ? [] : storage.reviews.listFindings(meta.taskId, cycle, head);
	const reviews: ReportReview[] = stored.map((review) => ({
		area: review.area,
		verdict: review.verdict,
		reason: review.reason,
		commit: review.commitSha,
		findings: findings
			.filter((finding) => finding.sources.some((source) => source.area === review.area))
			.map(findingOf)
			.sort((a, b) => a.uid.localeCompare(b.uid)),
	}));
	const openSevere = findings.filter((f) => SEVERE.has(f.severity) && f.status === "open").length;
	const acks = new Map(
		stored.flatMap((review) => review.acks.map((ack) => [ack.path, ack.decision] as const)),
	);
	return {
		key: meta.key,
		title: task?.title ?? meta.key,
		state: task?.state ?? "UNKNOWN",
		requirementIds: [...meta.requirementIds].sort(),
		integrationCommit: build?.integrationCommit ?? null,
		blockedReason: meta.blockedReason ?? build?.blockedReason ?? null,
		retries: cycle,
		repairs: build?.repairs ?? 0,
		checks: checks.filter((check) => check.taskId === meta.taskId).map(toRef),
		reviews,
		findingCounts: SEVERITY_ORDER.flatMap((severity) => {
			const of = findings.filter((f) => f.severity === severity);
			return of.length === 0
				? []
				: [
						{
							severity,
							open: of.filter((f) => f.status === "open").length,
							refuted: of.filter((f) => f.status === "refuted").length,
						},
					];
		}),
		acceptedOpen:
			openSevere === 0
				? findings.filter((f) => !SEVERE.has(f.severity) && f.status === "open").length
				: 0,
		requiresReview: [...(build?.protectedPaths ?? [])].sort().map((path) => ({
			path,
			ack: acks.get(path) ?? "sin_ack",
		})),
		ui: uiOf(deps, runId, meta.taskId, reviews),
	};
};

const hasEvidence = (task: ReportTask, checks: readonly Check[]): boolean =>
	task.state === "DONE" &&
	task.integrationCommit !== null &&
	checks.some(
		(check) =>
			check.exitCode === 0 &&
			check.commitSha === task.integrationCommit &&
			check.cwd === "integration" &&
			task.checks.some((own) => own.id === check.id),
	);

const requirementReport = (
	req: { id: string; text: string; priority: string; acceptance: string[] },
	tasks: readonly ReportTask[],
	checks: readonly Check[],
): ReportRequirement => {
	const covering = tasks.filter((task) => task.requirementIds.includes(req.id));
	const base = {
		id: req.id,
		text: req.text,
		priority: req.priority,
		acceptance: req.acceptance,
		taskKeys: covering.map((task) => task.key),
	};
	if (covering.length === 0) {
		return { ...base, status: "sin_evidencia", detail: "Ninguna tarea cubre este requisito." };
	}
	const pending = covering.filter((task) => task.state !== "DONE");
	if (pending.length > 0) {
		return {
			...base,
			status: "no_entregado",
			detail: pending
				.map(
					(task) =>
						`${task.key}: ${task.state}${task.blockedReason === null ? "" : ` (${task.blockedReason})`}`,
				)
				.join("; "),
		};
	}
	const unproven = covering.filter((task) => !hasEvidence(task, checks));
	return unproven.length > 0
		? {
				...base,
				status: "sin_evidencia",
				detail: `Sin check superado sobre el commit de integración: ${unproven.map((task) => task.key).join(", ")}.`,
			}
		: {
				...base,
				status: "entregado",
				detail: "Tareas DONE con check superado sobre su commit de integración.",
			};
};

const deliveryOf = (
	deps: ReportDeps,
	runId: string,
	target: string | null,
	checks: readonly Check[],
	preDelivery: boolean,
): ReportDelivery => {
	if (preDelivery) {
		return {
			target,
			status: "in_progress",
			cause: null,
			reportCommit: null,
			mainCommit: null,
			checks: [],
		};
	}
	const state = deliveryStateOf(deps.storage.events.list(runId, {}));
	return {
		target,
		status: state.status,
		cause: state.cause,
		reportCommit: state.reportCommit,
		mainCommit: state.mainCommit,
		checks: checks.filter((check) => check.cwd.startsWith(DELIVERY_CHECK_PREFIX)).map(toRef),
	};
};

const providerPhases = (deps: ReportDeps, runId: string): RunReport["provider"]["phases"] => {
	const byPhase: Record<"planning" | "build" | "review", string[]> = {
		planning: [],
		build: [],
		review: [],
	};
	for (const event of deps.storage.events.list(runId, {})) {
		if (event.type !== "role.called") continue;
		const phase = PHASE_OF_ROLE[String(event.payload.role)];
		const provider = String(event.payload.provider);
		if (phase !== undefined) byPhase[phase].push(PROVIDER_LABEL[provider] ?? provider);
	}
	return {
		planning: sortedUnique(byPhase.planning),
		build: sortedUnique(byPhase.build),
		review: sortedUnique(byPhase.review),
	};
};

const limitationsOf = (report: Omit<RunReport, "limitations">): string[] => {
	const lines: string[] = [];
	if (report.provider.mode === "fake") {
		lines.push(
			"Proveedor FALSO: la salida de planificación, construcción y revisión fue guionizada, no producida por un modelo; esto prueba el motor, no la calidad de un modelo.",
		);
	}
	if (report.provider.mode === "real") {
		lines.push(
			"Proveedor real: las salidas son de un modelo; los checks deterministas y las revisiones reducen, pero no eliminan, el riesgo de errores.",
		);
	}
	if (report.runner.notIsolated > 0) {
		lines.push(
			`Checks ejecutados en el host SIN aislamiento: ${report.runner.notIsolated} de ${report.runner.notIsolated + report.runner.isolated}.`,
		);
	}
	if (report.runner.isolation === "none") lines.push("No se registró ningún check.");
	if (report.budget.chargedUnknownUsd > 0) {
		lines.push(
			`Coste desconocido: ${report.budget.chargedUnknownUsd} USD se cargaron por reserva porque el proveedor no informó el coste real.`,
		);
	}
	for (const task of report.tasks) {
		if (task.ui.status === "unavailable") {
			lines.push(`Evidencia de navegador no disponible para ${task.key}: ${task.ui.reason}.`);
		}
		if (task.ui.status === "sin_evidencia") {
			lines.push(`Evidencia de navegador ausente para ${task.key} aunque UX/UI aplicaban.`);
		}
		if (task.state === "BLOCKED") {
			lines.push(`Tarea ${task.key} bloqueada: ${task.blockedReason ?? "causa no registrada"}.`);
		}
	}
	for (const req of report.requirements) {
		if (req.status !== "entregado") {
			lines.push(
				`Requisito ${req.id} ${req.status === "no_entregado" ? "no entregado" : "sin evidencia"}: ${req.detail}`,
			);
		}
	}
	if (report.integration.finalCheck === null) {
		lines.push("El check final de integración no se ha ejecutado o no está registrado.");
	} else if (!report.integration.finalCheckValid) {
		lines.push("El check final de integración no pasó.");
	}
	lines.push(
		"Producción no se ha publicado ni desplegado: la política `release.enabled` está desactivada por defecto y el informe no afirma ningún despliegue.",
	);
	return lines;
};

export const buildRunReport = (
	deps: ReportDeps,
	runId: string,
	options: ReportOptions = {},
): Result<RunReport, Failure<string>> => {
	const { storage } = deps;
	const run = storage.runs.get(runId);
	if (!run) return fail("run_not_found", `Run ${runId} not found`);
	const preDelivery = options.preDelivery === true;
	const allChecks = storage.checks.listByRun(runId);
	const checks = preDelivery
		? allChecks.filter((check) => !check.cwd.startsWith(DELIVERY_CHECK_PREFIX))
		: allChecks;
	const metas = [...storage.taskMeta.listByRun(runId)].sort((a, b) => a.key.localeCompare(b.key));
	const tasks = metas.map((meta) => taskReport(deps, runId, meta, checks));
	const version = storage.specs.latestVersion(runId);
	const spec = version === null ? undefined : storage.specs.getSpec(runId, version);
	const requirements = [...(spec?.requirements ?? [])]
		.sort((a, b) => a.id.localeCompare(b.id))
		.map((req) => requirementReport(req, tasks, checks));
	const finalCheck = checks.findLast((check) => check.cwd === FINAL_CHECK_CWD);
	const lastIntegration = tasks
		.map((task) => task.integrationCommit)
		.filter((commit): commit is string => commit !== null)
		.at(-1);
	const isolated = checks.filter((check) => check.isolated).length;
	const notIsolated = checks.length - isolated;
	const summary = storage.budgets.summary(runId);
	const status = getRunStatus({ storage }, { runId, eventLimit: 0 });
	const events = storage.events.list(runId, {});
	const project = storage.projects.findById(run.projectId);
	const unlimited: Omit<RunReport, "limitations"> = {
		schemaVersion: 1,
		runId,
		projectName: project?.name ?? "",
		state: preDelivery ? "READY_FOR_RELEASE" : run.state,
		inputSha256: run.inputHash,
		specVersion: version,
		integration: {
			head: finalCheck?.commitSha ?? lastIntegration ?? null,
			finalCheck: finalCheck === undefined ? null : toRef(finalCheck),
			finalCheckValid: finalCheck !== undefined && isCheckPassed(finalCheck),
		},
		provider: {
			mode: run.providerMode ?? "none",
			phases: providerPhases(deps, runId),
			fallbacks: fallbacksOf(events),
		},
		runner: {
			isolation:
				checks.length === 0
					? "none"
					: notIsolated === 0
						? "isolated"
						: isolated === 0
							? "host"
							: "mixed",
			isolated,
			notIsolated,
		},
		requirements,
		tasks,
		assumptions: (spec?.assumptions ?? []).map((a) => ({
			id: a.id,
			statement: a.statement,
			impact: a.impact,
			reversible: a.reversible,
			requirementIds: a.requirementIds,
		})),
		contradictions: (spec?.contradictions ?? []).map((c) => ({
			id: c.id,
			description: c.description,
			critical: c.critical,
			requirementIds: c.requirementIds,
		})),
		dependencyAudit: summarizeAudit(events),
		retries: {
			total: tasks.reduce((sum, task) => sum + task.retries, 0),
			repairs: tasks.reduce((sum, task) => sum + task.repairs, 0),
		},
		budget: {
			budgetUsd: summary.budgetUsd,
			chargedReportedUsd: summary.chargedReportedUsd,
			chargedUnknownUsd: summary.chargedUnknownUsd,
			reservedUsd: summary.reservedUsd,
			remainingUsd: summary.remainingUsd,
			calls: Object.entries(summary.callsByRole)
				.map(([role, calls]) => ({ role, calls }))
				.sort((a, b) => a.role.localeCompare(b.role)),
			retries: summary.retries,
		},
		delivery: deliveryOf(deps, runId, run.deliveryTarget, allChecks, preDelivery),
		release: { status: preDelivery ? "NOT_STARTED" : releaseStatusOf(events) },
		nextStep: status.ok ? status.value.nextStep : "",
	};
	return ok({ ...unlimited, limitations: limitationsOf(unlimited) });
};
