import { describe, expect, it } from "vitest";
import type { ArchitectOutput, SpecOutput } from "../src/contracts/planning.js";
import { TemplateManifestSchema } from "../src/contracts/templates.js";
import { plannerPrompt } from "../src/modules/planning/prompts.js";

const spec: SpecOutput = {
	requirements: [{ id: "REQ-001", text: "t", acceptance: ["a"], priority: "must", sourceRef: "s" }],
	assumptions: [],
	contradictions: [],
	outOfScope: [],
	openQuestions: [],
};
const architecture: ArchitectOutput = {
	presetIds: ["static-landing"],
	rationale: "r",
	omitted: [],
	decisions: [],
};

describe("plannerPrompt", () => {
	it("passes what the template already provides as delimited data and forbids scaffold-only tasks", () => {
		const prompt = plannerPrompt(spec, architecture, ["index.html with lang and viewport"]);
		const begin = prompt.indexOf("BEGIN_TEMPLATE_PROVIDES");
		const item = prompt.indexOf("index.html with lang and viewport");
		const end = prompt.indexOf("END_TEMPLATE_PROVIDES");
		expect(begin).toBeGreaterThan(-1);
		expect(item).toBeGreaterThan(begin);
		expect(end).toBeGreaterThan(item);
		expect(prompt).toContain("Do not create tasks that only scaffold");
	});

	it("omits the template block when nothing is declared", () => {
		expect(plannerPrompt(spec, architecture, [])).not.toContain("TEMPLATE_PROVIDES");
	});
});

describe("template manifests", () => {
	it("accept an optional provides list", () => {
		const parsed = TemplateManifestSchema.safeParse({
			id: "static-landing",
			presetIds: ["static-landing"],
			render: [],
			provides: ["index.html"],
		});
		expect(parsed.success).toBe(true);
	});
});
