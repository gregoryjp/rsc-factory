import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SpecOutput } from "../src/contracts/planning.js";
import { renderReportJson, renderReportMarkdown } from "../src/domain/report/render.js";
import { buildRunReport } from "../src/modules/delivery/build-report.js";
import { buildRun } from "../src/modules/execution/build-run.js";
import {
	type BuildEnv,
	blockedByBuilder,
	completed,
	createBuildEnv,
	greenImpl,
	redTest,
	task,
} from "./helpers/build-env.js";

const SPEC: SpecOutput = {
	requirements: [
		{
			id: "REQ-001",
			text: "Add numbers",
			acceptance: ["add works"],
			priority: "must",
			sourceRef: "PRD",
		},
		{
			id: "REQ-002",
			text: "Subtract numbers",
			acceptance: ["sub works"],
			priority: "must",
			sourceRef: "PRD",
		},
		{
			id: "REQ-003",
			text: "Export a CSV",
			acceptance: ["csv works"],
			priority: "next",
			sourceRef: "PRD",
		},
	],
	assumptions: [
		{
			id: "ASM-001",
			statement: "Integers only",
			reason: "PRD silent",
			impact: "low",
			reversible: true,
			requirementIds: ["REQ-001"],
		},
	],
	contradictions: [
		{
			id: "CON-001",
			requirementIds: ["REQ-001", "REQ-002"],
			description: "Signs unclear",
			critical: false,
		},
	],
	outOfScope: [],
	openQuestions: [],
};

const normalizeHashes = (text: string): string => {
	const seen = new Map<string, string>();
	return text.replace(/\b[0-9a-f]{40}\b|\b[0-9a-f]{64}\b/g, (hash) => {
		const known = seen.get(hash);
		if (known !== undefined) return known;
		const label = `<${hash.length === 40 ? "sha1" : "sha256"}:${seen.size + 1}>`;
		seen.set(hash, label);
		return label;
	});
};

const partialRun = async (): Promise<BuildEnv> => {
	const env = await createBuildEnv({
		spec: SPEC,
		tasks: [task("add", [], ["REQ-001"]), task("sub", [], ["REQ-002"])],
		builder: [completed(redTest("add")), completed(greenImpl("add")), blockedByBuilder()],
	});
	const built = await buildRun(env.deps, { runId: env.runId });
	if (!built.ok) throw new Error(built.error.message);
	return env;
};

const reportOf = (env: BuildEnv) => {
	const report = buildRunReport(env.deps, env.runId);
	if (!report.ok) throw new Error(report.error.message);
	return report.value;
};

describe("run report", () => {
	it("traces each requirement to its evidence and never implies a blocked or untasked requirement is done", async () => {
		const env = await partialRun();
		const report = reportOf(env);
		expect(report.requirements.map((r) => [r.id, r.status])).toEqual([
			["REQ-001", "entregado"],
			["REQ-002", "no_entregado"],
			["REQ-003", "sin_evidencia"],
		]);
		const add = report.tasks.find((t) => t.key === "add");
		expect(add).toMatchObject({ state: "DONE", requirementIds: ["REQ-001"] });
		expect(add?.integrationCommit).toMatch(/^[0-9a-f]{40}$/);
		expect(add?.checks.length).toBeGreaterThan(0);
		expect(add?.reviews.map((r) => [r.area, r.verdict])).toEqual([
			["security", "pass"],
			["code", "pass"],
			["legal", "not_applicable"],
			["ux", "not_applicable"],
			["ui", "not_applicable"],
		]);
		const sub = report.tasks.find((t) => t.key === "sub");
		expect(sub).toMatchObject({ state: "BLOCKED", integrationCommit: null });
		expect(sub?.blockedReason).toBeTruthy();
		expect(report.integration.finalCheck).toBeNull();
	});

	it("labels the fake provider, the missing isolation and the unknown cost explicitly", async () => {
		const env = await partialRun();
		const reserved = env.storage.budgets.reserve({
			runId: env.runId,
			role: "builder",
			amountUsd: 1,
			now: 1,
		});
		if (!reserved.ok) throw new Error(reserved.error.message);
		env.storage.budgets.settle({
			reservationId: reserved.value,
			chargeUsd: 1,
			basis: "unknown_reservation",
			now: 1,
		});
		const report = reportOf(env);
		expect(report.provider).toMatchObject({
			mode: "fake",
			phases: { planning: ["fake"], build: ["fake"], review: ["fake"] },
		});
		expect(report.runner).toEqual({
			isolation: "host",
			isolated: 0,
			notIsolated: expect.any(Number),
		});
		expect(report.budget.chargedUnknownUsd).toBeGreaterThan(0);
		const markdown = renderReportMarkdown(report);
		expect(markdown).toContain("Proveedor: FALSO");
		expect(markdown).toContain("SIN aislamiento");
		expect(markdown).toContain("no entregado");
		expect(markdown).toContain("sin evidencia");
		expect(markdown).toContain("coste desconocido");
		expect(report.limitations.join("\n")).toContain("guionizad");
	});

	it("is deterministic: the same state renders byte-identical markdown and JSON", async () => {
		const env = await partialRun();
		const first = reportOf(env);
		const second = reportOf(env);
		expect(renderReportMarkdown(first)).toBe(renderReportMarkdown(second));
		expect(renderReportJson(first)).toBe(renderReportJson(second));
		expect(JSON.parse(renderReportJson(first))).toMatchObject({ schemaVersion: 1 });
	});

	it("matches the golden report of a scripted run with a blocked requirement", async () => {
		const env = await partialRun();
		const markdown = renderReportMarkdown(reportOf(env));
		await expect(normalizeHashes(markdown)).toMatchFileSnapshot("golden/run-report.md");
	});

	it("reports the final integration check and a delivered requirement set for a finished run", async () => {
		const env = await createBuildEnv({
			spec: { ...SPEC, requirements: SPEC.requirements.slice(0, 1), contradictions: [] },
			tasks: [task("add")],
			builder: [completed(redTest("add")), completed(greenImpl("add"))],
		});
		const built = await buildRun(env.deps, { runId: env.runId });
		if (!built.ok) throw new Error(built.error.message);
		const report = reportOf(env);
		expect(report.state).toBe("READY_FOR_RELEASE");
		expect(report.requirements.map((r) => r.status)).toEqual(["entregado"]);
		expect(report.integration.finalCheck).toMatchObject({ exitCode: 0, cwd: "integration-final" });
		expect(report.integration.finalCheckValid).toBe(true);
		expect(report.integration.head).toBe(report.integration.finalCheck?.commitSha);
	});

	it("shows captured browser evidence with roles and flags unavailable evidence as a limitation", async () => {
		const env = await partialRun();
		const taskId = env.taskIds.add ?? "";
		const head = env.buildOf("add")?.integrationCommit ?? "";
		const dir = `runs/${env.runId}/ui/${head}`;
		mkdirSync(join(env.home, dir, "shots"), { recursive: true });
		const viewport = { name: "desktop", width: 1440, height: 900 };
		const page = (as: string | null) => ({
			status: "captured",
			route: "/",
			as,
			authenticated: as !== null,
			viewport,
			axe: { violations: [{ id: "color-contrast", impact: "serious", help: "h", nodes: 1 }] },
			overflow: { scrollWidth: 10, clientWidth: 10, overflows: false },
			focus: { checked: 1, withoutIndicator: [] },
			consoleErrors: [],
			screenshot: { path: `shots/${as ?? "public"}.png`, sha256: "a".repeat(64), bytes: 10 },
		});
		writeFileSync(
			join(env.home, dir, "ui-evidence.json"),
			JSON.stringify({
				schemaVersion: 1,
				commitSha: head,
				scriptSha256: "b".repeat(64),
				playwrightVersion: "1",
				axeVersion: "4",
				pages: [page(null), page("admin")],
			}),
		);
		env.storage.events.append({
			runId: env.runId,
			taskId,
			type: "task.ui_evidence",
			payload: {
				status: "captured",
				commit: head,
				dir,
				pages: 2,
				axeViolations: 2,
				overflowPages: 0,
			},
			now: 1,
		});
		const withUi = reportOf(env).tasks.find((t) => t.key === "add")?.ui;
		expect(withUi).toEqual({
			status: "captured",
			dir,
			pages: 2,
			axeViolations: 2,
			overflowPages: 0,
			screenshots: ["shots/admin.png", "shots/public.png"],
			authenticatedRoles: ["admin"],
		});
		env.storage.events.append({
			runId: env.runId,
			taskId,
			type: "task.ui_evidence",
			payload: { status: "unavailable", commit: head, reason: "docker not available" },
			now: 2,
		});
		const report = reportOf(env);
		expect(report.tasks.find((t) => t.key === "add")?.ui).toEqual({
			status: "unavailable",
			reason: "docker not available",
		});
		expect(report.limitations.join("\n")).toContain("docker not available");
	});
});
