import type { PlannedTask, Risk } from "../../contracts/planning.js";

type RiskRule = { pattern: RegExp; scope: "paths" | "text" | "both" };

export const RISK_RULES: Record<string, RiskRule> = {
	auth: { pattern: /auth|login|inicia(?:r)? sesi/i, scope: "both" },
	session: { pattern: /session|sesi[oó]n/i, scope: "both" },
	password: { pattern: /password|contrase/i, scope: "both" },
	payment: { pattern: /payment|billing|checkout|pago|cobro/i, scope: "both" },
	migration: { pattern: /migrat/i, scope: "both" },
	"prisma-schema": { pattern: /prisma\/schema|\.prisma$/i, scope: "paths" },
	tenant: { pattern: /tenant|multiempresa/i, scope: "both" },
	secret: { pattern: /secret|credential|api[-_ ]?key|\.env/i, scope: "both" },
	delete: { pattern: /delete|destroy|borrar|eliminar/i, scope: "both" },
	"personal-data": {
		pattern:
			/personal data|datos personales|privacy|privacidad|consent|gdpr|rgpd|cookie|tracking|delete account|eliminar cuenta|borrar cuenta/i,
		scope: "both",
	},
	authorization: { pattern: /authoriz|autoriz|permission|permiso|rbac/i, scope: "both" },
};

export type RiskAdjusted = Omit<PlannedTask, "risk"> & {
	risk: Risk;
	modelRisk: Risk;
	riskReasons: string[];
};

export const applyRiskFloor = (
	task: PlannedTask,
	requirementTexts: readonly string[],
): RiskAdjusted => {
	const paths = task.expectedPaths.join("\n");
	const text = requirementTexts.join("\n");
	const riskReasons = Object.entries(RISK_RULES).flatMap(([id, rule]) => {
		const inPaths = rule.scope !== "text" && rule.pattern.test(paths);
		const inText = rule.scope !== "paths" && rule.pattern.test(text);
		return inPaths || inText ? [`${id} (${inPaths ? "paths" : "requirement text"})`] : [];
	});
	return {
		...task,
		modelRisk: task.risk,
		risk: riskReasons.length > 0 ? "high" : task.risk,
		riskReasons,
	};
};
