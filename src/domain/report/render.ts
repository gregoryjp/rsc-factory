import type { CheckRef, ReportTask, ReportUi, RequirementStatus, RunReport } from "./types.js";

const STATUS_LABEL: Record<RequirementStatus, string> = {
	entregado: "entregado",
	no_entregado: "no entregado",
	sin_evidencia: "sin evidencia",
};

const PROVIDER_LABEL: Record<RunReport["provider"]["mode"], string> = {
	fake: "FALSO (guionizado; la salida no la produjo un modelo)",
	real: "real (claude)",
	none: "ninguno (sin llamadas al proveedor)",
};

const RUNNER_LABEL: Record<RunReport["runner"]["isolation"], string> = {
	isolated: "aislado (Docker)",
	host: "host SIN aislamiento",
	mixed: "mixto: parte de los checks SIN aislamiento",
	none: "sin checks registrados",
};

const DELIVERY_LABEL: Record<RunReport["delivery"]["status"], string> = {
	not_started: "no iniciada",
	in_progress: "en curso (el informe se escribe antes del merge a main)",
	delivered: "entregada",
	failed: "fallida",
};

const AUDIT_STATUS_LABEL: Record<string, string> = {
	baseline: "línea base registrada",
	pass: "sin vulnerabilidades altas/críticas nuevas",
	new_vulnerability: "BLOQUEA: vulnerabilidad alta/crítica nueva",
	unavailable: "no disponible (no cuenta como aprobada; bloquea la entrega)",
	skipped: "omitida",
};

const auditRefs = (refs: readonly { id: string; package: string; severity: string }[]): string =>
	refs.length === 0
		? "ninguna"
		: refs.map((r) => `${r.package} ${r.id} (${r.severity})`).join(", ");

const auditLines = (report: RunReport): string[] =>
	report.dependencyAudit.entries.length === 0
		? []
		: [
				"## Auditoría de dependencias",
				"",
				...report.dependencyAudit.entries.flatMap((entry) => [
					`- ${entry.phase}: ${AUDIT_STATUS_LABEL[entry.status] ?? entry.status}${entry.reason === null ? "" : ` (${entry.reason})`}.`,
					...(entry.counts === null || entry.phase === "baseline"
						? []
						: [
								`  - Por severidad: crítica ${entry.counts.critical}, alta ${entry.counts.high}, moderada ${entry.counts.moderate}, baja ${entry.counts.low}, info ${entry.counts.info}.`,
								`  - Nuevas altas/críticas: ${auditRefs(entry.newSevere)}.`,
							]),
					`  - accepted_baseline: ${auditRefs(entry.acceptedBaseline)}.`,
				]),
				"",
			];

const list = (items: readonly string[], empty = "ninguno"): string =>
	items.length === 0 ? empty : items.join(", ");

const checkLine = (check: CheckRef): string =>
	`\`${check.argv.join(" ")}\` -> exit ${check.exitCode} (${check.cwd}, commit \`${check.commitSha}\`, ${check.isolated ? "aislado" : "SIN aislamiento"}, log \`${check.logPath}\`, sha256 \`${check.logSha256}\`)`;

const uiLine = (ui: ReportUi): string => {
	if (ui.status === "captured") {
		return `capturada en \`${ui.dir}\`: ${ui.pages} páginas, ${ui.axeViolations} violaciones axe, ${ui.overflowPages} páginas con desbordamiento; capturas: ${list(ui.screenshots)}; roles autenticados: ${list(ui.authenticatedRoles)}`;
	}
	if (ui.status === "unavailable") return `NO DISPONIBLE (${ui.reason})`;
	if (ui.status === "not_reviewed") return "no revisada (la tarea no llegó a la revisión)";
	if (ui.status === "not_applicable") return "no aplica (el cambio no toca la interfaz)";
	return "SIN EVIDENCIA (UX/UI aplicaban y no hay captura)";
};

const taskSection = (task: ReportTask): string[] => [
	`### ${task.key}: ${task.title}`,
	"",
	`- Estado: ${task.state}${task.blockedReason === null ? "" : ` (${task.blockedReason})`}`,
	`- Requisitos: ${list(task.requirementIds)}`,
	`- Commit de integración: ${task.integrationCommit === null ? "ninguno" : `\`${task.integrationCommit}\``}`,
	`- Reintentos: ${task.retries}; reparaciones: ${task.repairs}`,
	"- Checks:",
	...(task.checks.length === 0 ? ["  - ninguno"] : task.checks.map((c) => `  - ${checkLine(c)}`)),
	"- Revisiones:",
	...(task.reviews.length === 0
		? ["  - ninguna"]
		: task.reviews.flatMap((review) => [
				`  - ${review.area}: ${review.verdict}${review.reason === null ? "" : ` (${review.reason})`} sobre \`${review.commit}\``,
				...review.findings.map(
					(f) =>
						`    - [${f.severity}] ${f.title} (${f.status}${f.refutation === null ? "" : `, refutación ${f.refutation}`})${f.file === null ? "" : ` en ${f.file}`}`,
				),
			])),
	`- Hallazgos por severidad: ${
		task.findingCounts.length === 0
			? "ninguno"
			: task.findingCounts
					.map((c) => `${c.severity} abiertos=${c.open} refutados=${c.refuted}`)
					.join("; ")
	}; aceptados abiertos (no graves)=${task.acceptedOpen}`,
	`- Archivos que exigen revisión: ${
		task.requiresReview.length === 0
			? "ninguno"
			: task.requiresReview.map((r) => `${r.path} (${r.ack})`).join(", ")
	}`,
	`- Evidencia de navegador: ${uiLine(task.ui)}`,
	"",
];

export const renderReportMarkdown = (report: RunReport): string =>
	[
		`# Informe de la factory: run ${report.runId}`,
		"",
		`Proyecto: ${report.projectName}. Hash de entrada (PRD): \`${report.inputSha256}\`. Versión de spec: ${report.specVersion === null ? "ninguna" : `v${report.specVersion}`}.`,
		"",
		"## Etiquetado de la evidencia",
		"",
		`- Proveedor: ${PROVIDER_LABEL[report.provider.mode]}.`,
		`- Proveedor por fase: planificación ${list(report.provider.phases.planning, "sin llamadas")}; construcción ${list(report.provider.phases.build, "sin llamadas")}; revisión ${list(report.provider.phases.review, "sin llamadas")}.`,
		`- Runner de checks: ${RUNNER_LABEL[report.runner.isolation]} (${report.runner.isolated} aislados, ${report.runner.notIsolated} sin aislamiento).`,
		"- Evidencia omitida o no disponible: ver «Limitaciones».",
		"",
		"## Resumen",
		"",
		`- Estado del run: ${report.state}.`,
		`- Entrega (${report.delivery.target ?? "sin declarar"}): ${DELIVERY_LABEL[report.delivery.status]}${report.delivery.cause === null ? "" : `, causa ${report.delivery.cause}`}.`,
		`- Release: ${report.release.status}. Producción no está publicada.`,
		`- Commit de integración: ${report.integration.head === null ? "ninguno" : `\`${report.integration.head}\``}.`,
		`- Check final: ${report.integration.finalCheck === null ? "no registrado" : checkLine(report.integration.finalCheck)}${report.integration.finalCheck !== null && !report.integration.finalCheckValid ? " (NO pasó)" : ""}.`,
		"",
		"## Requisitos y evidencia",
		"",
		...report.requirements.flatMap((req) => [
			`### ${req.id} (${req.priority}): ${STATUS_LABEL[req.status]}`,
			"",
			`${req.text}`,
			"",
			`- Aceptación: ${req.acceptance.join(" | ")}`,
			`- Tareas: ${list(req.taskKeys)}`,
			`- Detalle: ${req.detail}`,
			"",
		]),
		"## Tareas",
		"",
		...report.tasks.flatMap(taskSection),
		"## Supuestos",
		"",
		...(report.assumptions.length === 0
			? ["- ninguno"]
			: report.assumptions.map(
					(a) =>
						`- ${a.id}: ${a.statement} (impacto ${a.impact}, ${a.reversible ? "reversible" : "irreversible"}; requisitos ${list(a.requirementIds)})`,
				)),
		"",
		"## Contradicciones",
		"",
		...(report.contradictions.length === 0
			? ["- ninguna"]
			: report.contradictions.map(
					(c) =>
						`- ${c.id}${c.critical ? " (CRÍTICA)" : ""}: ${c.description} (requisitos ${list(c.requirementIds)})`,
				)),
		"",
		...auditLines(report),
		"## Reintentos y reparaciones",
		"",
		`- Reintentos manuales: ${report.retries.total}; reparaciones del builder: ${report.retries.repairs}; reintentos del proveedor: ${report.budget.retries}.`,
		"",
		"## Presupuesto",
		"",
		`- Presupuesto: ${report.budget.budgetUsd} USD; coste informado ${report.budget.chargedReportedUsd} USD; coste desconocido ${report.budget.chargedUnknownUsd} USD${report.budget.chargedUnknownUsd > 0 ? " (coste desconocido: cargado por reserva)" : ""}; reservado ${report.budget.reservedUsd} USD; restante ${report.budget.remainingUsd} USD.`,
		`- Llamadas por rol: ${list(
			report.budget.calls.map((c) => `${c.role}=${c.calls}`),
			"ninguna",
		)}.`,
		"",
		"## Entrega",
		"",
		...(report.delivery.checks.length === 0
			? ["- Sin checks de entrega registrados aún."]
			: report.delivery.checks.map((c) => `- ${checkLine(c)}`)),
		`- Commit del informe: ${report.delivery.reportCommit === null ? "ninguno" : `\`${report.delivery.reportCommit}\``}; commit de merge en main: ${report.delivery.mainCommit === null ? "ninguno" : `\`${report.delivery.mainCommit}\``}.`,
		"",
		"## Limitaciones",
		"",
		...report.limitations.map((line) => `- ${line}`),
		"",
		"## Siguiente paso",
		"",
		report.nextStep,
		"",
	].join("\n");

export const renderReportJson = (report: RunReport): string =>
	`${JSON.stringify(report, null, 2)}\n`;
