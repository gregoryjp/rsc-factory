import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RolesConfigSchema } from "../src/contracts/planning.js";
import { independenceWarnings } from "../src/domain/planning/roles.js";
import { loadRoleAssets } from "../src/modules/planning/run-role.js";
import { ok } from "../src/shared/result.js";
import { REPO_ROOT } from "./helpers/env.js";

const rolesJson = () => readFileSync(join(REPO_ROOT, "factory", "config", "roles.json"), "utf8");

const shipped = () => RolesConfigSchema.parse(JSON.parse(rolesJson()));

describe("roles config", () => {
	it("ships the per-role provider and model defaults", () => {
		const roles = shipped();
		for (const role of ["spec-writer", "architect", "planner", "approver"] as const) {
			expect(roles[role]).toEqual({ provider: "claude", model: "opus" });
		}
		for (const role of [
			"builder",
			"reviewer-security",
			"reviewer-code",
			"reviewer-legal",
			"review-refuter",
		] as const) {
			expect(roles[role]).toEqual({ provider: "claude", model: "sonnet" });
		}
		for (const role of ["reviewer-ux", "reviewer-ui"] as const) {
			expect(roles[role]).toEqual({ provider: "codex", model: "gpt-6-astra", effort: "medium" });
		}
	});

	it("rejects the legacy string shape, unknown providers and effort on claude", () => {
		const base = shipped();
		expect(RolesConfigSchema.safeParse({ ...base, builder: "sonnet" }).success).toBe(false);
		expect(
			RolesConfigSchema.safeParse({ ...base, builder: { provider: "gemini", model: "x" } }).success,
		).toBe(false);
		expect(
			RolesConfigSchema.safeParse({
				...base,
				builder: { provider: "claude", model: "sonnet", effort: "high" },
			}).success,
		).toBe(false);
		expect(
			RolesConfigSchema.safeParse({
				...base,
				builder: { provider: "codex", model: "gpt-6-astra", effort: "extreme" },
			}).success,
		).toBe(false);
	});

	it("exposes provider, model and effort through the role assets", () => {
		const content = rolesJson();
		const deps = {
			factoryFiles: {
				read: (path: string) =>
					ok({ content: path.endsWith("roles.json") ? content : `# ${path}`, sha256: "x" }),
			},
		};
		const ui = loadRoleAssets(deps, "reviewer-ui");
		expect(ui).toMatchObject({
			ok: true,
			value: { provider: "codex", model: "gpt-6-astra", effort: "medium" },
		});
		const builder = loadRoleAssets(deps, "builder");
		expect(builder).toMatchObject({ ok: true, value: { provider: "claude", model: "sonnet" } });
		expect(builder.ok && builder.value.effort).toBeUndefined();
	});
});

describe("reviewer independence", () => {
	it("warns for each reviewer that shares provider and model with the builder", () => {
		const warnings = independenceWarnings(shipped());
		expect(warnings).toHaveLength(3);
		expect(warnings.join("\n")).toContain("reviewer-security");
		expect(warnings.join("\n")).toContain("reviewer-code");
		expect(warnings.join("\n")).toContain("reviewer-legal");
		expect(warnings.join("\n")).not.toContain("reviewer-ui");
		expect(warnings[0]).toContain("claude/sonnet");
	});

	it("stays silent when no reviewer matches the builder", () => {
		const independent = RolesConfigSchema.parse({
			...shipped(),
			"reviewer-security": { provider: "codex", model: "gpt-6-astra" },
			"reviewer-code": { provider: "claude", model: "opus" },
			"reviewer-legal": { provider: "codex", model: "gpt-6-sol" },
		});
		expect(independenceWarnings(independent)).toEqual([]);
	});
});
