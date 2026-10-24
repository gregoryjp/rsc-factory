import { z } from "zod";

export const RELEASE_POLICY_PATH = "factory/policies/release.json";
export const RUNBOOK_PATH = "docs/operations/release.md";

export const ReleasePolicySchema = z.strictObject({ enabled: z.boolean() });
export type ReleasePolicy = z.infer<typeof ReleasePolicySchema>;
export const DEFAULT_RELEASE_POLICY: ReleasePolicy = { enabled: false };

export type ReleasePlan = {
	schemaVersion: 1;
	runId: string;
	projectName: string;
	templateId: string;
	commit: string | null;
	runbookPath: string;
	publishingEnabled: boolean;
	build: { install: string[]; check: string[]; build: string[] | null };
	migrations: { migrate: string[] | null };
	smoke: { healthPath: string | null };
	rollback: string[];
};

export const ROLLBACK_STEPS: readonly string[] = [
	"Volver a desplegar el artefacto anterior (el commit previo de `main`) con el mismo procedimiento que se usó para publicar.",
	"No revertir el esquema de datos automáticamente: el rollback de la aplicación no implica un rollback seguro del esquema. Preferir migraciones expand/contract (añadir primero, retirar después) para que la versión anterior siga funcionando contra el esquema nuevo.",
	"Si una migración fue destructiva o irreversible, restaurar la copia de seguridad tomada antes de migrar y repetir los checks de humo contra la versión anterior.",
	"Registrar el incidente con la evidencia del check de humo fallido antes de volver a intentar la publicación.",
];

const argv = (value: readonly string[]): string => `\`${value.join(" ")}\``;

export const renderReleaseRunbook = (plan: ReleasePlan): string =>
	[
		`# Runbook de release: ${plan.projectName}`,
		"",
		`Generado por la factory para el run \`${plan.runId}\` (plantilla \`${plan.templateId}\`). ${
			plan.publishingEnabled
				? "La publicación está habilitada por política."
				: "La publicación a producción está DESACTIVADA (`release.enabled=false`): este documento prepara el release, no lo ejecuta."
		}`,
		"",
		"## 1. Artefacto inmutable",
		"",
		"Construir siempre desde el commit exacto de `main` entregado por la factory (el commit de merge que imprime `factory deliver`; `git rev-parse main`). No construir desde un árbol de trabajo con cambios.",
		"",
		`1. \`git checkout <commit-de-main>\``,
		...(plan.build.install.length > 0
			? [`2. Instalar dependencias de forma reproducible: ${argv(plan.build.install)}.`]
			: []),
		`3. Verificar: ${argv(plan.build.check)} debe terminar con exit 0.`,
		...(plan.build.build === null ? [] : [`4. Construir: ${argv(plan.build.build)}.`]),
		"5. Guardar el artefacto junto con el hash del commit; no reconstruirlo para otro entorno.",
		"",
		"## 2. Migraciones con copia y restauración",
		"",
		...(plan.migrations.migrate === null
			? ["Esta plantilla no declara migraciones de datos. Si añade alguna, aplicar esta sección."]
			: [
					"1. Tomar una copia de seguridad completa de la base de datos y comprobar que se puede restaurar en un entorno de ensayo.",
					`2. Ensayar la migración en una copia: ${argv(plan.migrations.migrate)}.`,
					"3. Revisar que la migración es compatible hacia atrás (expand/contract) antes de aplicarla en producción.",
					`4. Aplicar en producción: ${argv(plan.migrations.migrate)}.`,
				]),
		"",
		"## 3. Checks de humo (smoke)",
		"",
		plan.smoke.healthPath === null
			? "1. Abrir la aplicación y comprobar la página principal y el flujo crítico del producto."
			: `1. Consultar \`${plan.smoke.healthPath}\` y comprobar respuesta correcta.`,
		"2. Recorrer el flujo principal descrito en el PRD con una cuenta de prueba.",
		"3. Un smoke fallido impide etiquetar el release como sano: ejecutar la sección de rollback.",
		"",
		"## 4. Rollback",
		"",
		...plan.rollback.map((step, index) => `${index + 1}. ${step}`),
		"",
	].join("\n");
