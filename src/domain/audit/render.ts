import type { StateDiff } from "./target-state.js";

export type AuditResultKind = "passed" | "checks_failed" | "skipped" | "target_mutated";

export type AuditReport = {
	auditId: string;
	runId: string;
	targetPath: string;
	headSha: string;
	result: AuditResultKind;
	checkMode: "template" | "generic" | "skipped";
	templateId: string | null;
	skipReason: string | null;
	runner: { kind: "docker" | "host"; isolated: boolean };
	provider: "fake" | "real" | null;
	checks: {
		argv: string[];
		exitCode: number;
		commitSha: string;
		logPath: string;
		logSha256: string;
		isolated: boolean;
	}[];
	reviews:
		| {
				area: string;
				verdict: string;
				reason: string | null;
				findings: { severity: string; title: string; file: string | null }[];
		  }[]
		| null;
	before: { head: string; fileCount: number };
	after: { head: string; fileCount: number };
	diff: StateDiff;
	limitations: string[];
};

const RESULT_LABEL: Record<AuditResultKind, string> = {
	passed: "checks superados",
	checks_failed: "checks fallidos",
	skipped: "checks omitidos",
	target_mutated: "ERROR: el repositorio objetivo cambió durante la auditoría (target_mutated)",
};

const checkLine = (check: AuditReport["checks"][number]): string =>
	`- \`${check.argv.join(" ")}\`: exit ${check.exitCode}, commit \`${check.commitSha}\`, log \`${check.logPath}\` (sha256 \`${check.logSha256}\`), ${check.isolated ? "aislado" : "SIN aislamiento (host)"}`;

export const renderAuditMarkdown = (report: AuditReport): string =>
	[
		`# Auditoría ${report.auditId}`,
		"",
		`- Repositorio: \`${report.targetPath}\``,
		`- Commit auditado (HEAD): \`${report.headSha}\``,
		`- Resultado: ${RESULT_LABEL[report.result]}`,
		`- Runner: ${report.runner.kind} (${report.runner.isolated ? "aislado" : "SIN aislamiento"})`,
		`- Modo de checks: ${report.checkMode}${report.templateId === null ? "" : ` (plantilla ${report.templateId})`}`,
		...(report.skipReason === null ? [] : [`- Checks omitidos: ${report.skipReason}`]),
		"",
		"## Checks",
		...(report.checks.length === 0 ? ["- Ninguno ejecutado."] : report.checks.map(checkLine)),
		"",
		"## Revisores",
		...(report.reviews === null
			? [`- No solicitados (use \`--review\`).`]
			: report.reviews.flatMap((review) => [
					`- ${review.area}: ${review.verdict}${review.reason === null ? "" : ` (${review.reason})`}; hallazgos: ${review.findings.length}`,
					...review.findings.map(
						(f) => `  - [${f.severity}] ${f.title}${f.file === null ? "" : ` (${f.file})`}`,
					),
				])),
		`- Proveedor: ${report.provider === null ? "no usado" : report.provider === "fake" ? "FALSO (guionizado, no es un modelo)" : "real"}`,
		"",
		"## Estado del repositorio objetivo",
		`- Antes: HEAD \`${report.before.head}\`, ${report.before.fileCount} archivos con huella.`,
		`- Después: HEAD \`${report.after.head}\`, ${report.after.fileCount} archivos con huella.`,
		report.result === "target_mutated"
			? [
					`- Diferencias: HEAD ${report.diff.headChanged ? "cambió" : "igual"}, estado git ${report.diff.statusChanged ? "cambió" : "igual"}.`,
					...report.diff.files.map((f) => `  - ${f.change}: \`${f.path}\``),
				].join("\n")
			: "- Sin diferencias: HEAD, `git status` y los hashes de archivos son idénticos.",
		"",
		"## Limitaciones",
		...report.limitations.map((line) => `- ${line}`),
		"",
	].join("\n");
