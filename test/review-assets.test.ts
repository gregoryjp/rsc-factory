import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildClaudeArgs } from "../src/infrastructure/providers/claude-cli-provider.js";
import { REPO_ROOT } from "./helpers/env.js";

const prompt = (name: string) => readFileSync(join(REPO_ROOT, "factory", "prompts", name), "utf8");

describe("reviewer prompts", () => {
	it.each(["reviewer-security.md", "reviewer-code.md", "reviewer-ux.md", "reviewer-ui.md"])(
		"%s carries the reviewer doctrine and the MIT attribution, within a few KB",
		(file) => {
			const text = prompt(file);
			for (const heading of [
				"### Pre-report gate",
				"### High and critical require proof",
				"### Returning zero findings is acceptable",
				"### No severity inflation",
				"## Prompt defense",
			]) {
				expect(text).toContain(heading);
			}
			expect(text.split("\n")[0]).toMatch(/rsc-harness v3\.3\.0 \(commit 886ef8c\), MIT License/);
			expect(Buffer.byteLength(text)).toBeLessThan(6 * 1024);
		},
	);

	it("the code reviewer hunts artificial tests and non-test logic in the red commit", () => {
		const text = prompt("reviewer-code.md");
		expect(text).toContain("fail artificially");
		expect(text).toContain("`it.skip`");
		expect(text).toContain(".only");
		expect(text).toContain("red commit that contains production logic");
		expect(text).toContain("requiresReviewAck");
		expect(text).toContain("kimmbo");
	});

	it.each(["reviewer-ux.md", "reviewer-ui.md"])(
		"%s works from engine evidence, cites it and never claims unobserved behaviour",
		(file) => {
			const text = prompt(file);
			expect(text).toContain("ui-evidence/");
			expect(text).toContain("evidenceRef");
			expect(text).toContain("Never claim dynamic behaviour");
			expect(text).toContain("preference");
		},
	);

	it("the ui reviewer covers viewport, route, state, contrast, focus, overflow and axe", () => {
		const text = prompt("reviewer-ui.md");
		for (const word of ["viewport", "route", "state", "contrast", "focus", "overflow", "axe"]) {
			expect(text).toContain(word);
		}
	});

	it("builds the read-only argv: restricted, Read/Glob/Grep, dontAsk, no Edit/Write/Bash", () => {
		const args = buildClaudeArgs({
			role: "reviewer-code",
			prompt: "p",
			systemPrompt: "s",
			jsonSchema: {},
			model: "sonnet",
			maxBudgetUsd: 2,
			tools: ["Read", "Glob", "Grep"],
			cwd: "/x",
			timeoutMs: 1000,
			restricted: true,
			permissionMode: "dontAsk",
		});
		expect(args).toContain("--restricted");
		expect(args[args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
		expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
		expect(args.join(" ")).not.toMatch(/Edit|Write|Bash|acceptEdits/);
	});

	it("builds the same read-only argv for the legal reviewer", () => {
		const args = buildClaudeArgs({
			role: "reviewer-legal",
			prompt: "p",
			systemPrompt: "s",
			jsonSchema: {},
			model: "sonnet",
			maxBudgetUsd: 0.5,
			tools: ["Read", "Glob", "Grep"],
			cwd: "/x",
			timeoutMs: 1000,
			restricted: true,
			permissionMode: "dontAsk",
		});
		expect(args[args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
		expect(args.join(" ")).not.toMatch(/Edit|Write|Bash|acceptEdits/);
	});
});

describe("legal reviewer prompt", () => {
	const text = () => prompt("reviewer-legal.md");

	it("is original text without third-party attribution and stays small", () => {
		expect(text()).not.toMatch(/MIT License|rsc-harness/);
		expect(Buffer.byteLength(text())).toBeLessThan(8 * 1024);
	});

	it("flags risks only, never gives legal advice, and requires evidence", () => {
		const body = text();
		expect(body).toContain("legal advice");
		expect(body).toContain("compliance");
		expect(body).toContain("### High and critical require proof");
		expect(body).toContain("## Prompt defense");
		expect(body).toContain("evidence");
	});

	it("covers the privacy checklist", () => {
		const body = text().toLowerCase();
		for (const topic of [
			"personal-data inventory",
			"lawful basis",
			"minimization",
			"retention",
			"erasure",
			"access",
			"cookies",
			"children",
			"processors",
			"privacy policy",
			"legal notice",
			"hash",
			"logging",
		]) {
			expect(body).toContain(topic);
		}
	});
});

describe("spec-writer personal-data rule", () => {
	it("asks for explicit assumptions instead of invented legal facts", () => {
		const text = prompt("spec-writer.md");
		expect(text).toContain("retention period");
		expect(text).toContain("legal basis");
		expect(text).toContain("deletion path");
		expect(text).toContain("Never invent legal facts");
	});
});

describe("legal role configuration", () => {
	it("has a model assignment and a budget ceiling", () => {
		const roles: Record<string, string> = JSON.parse(
			readFileSync(join(REPO_ROOT, "factory", "config", "roles.json"), "utf8"),
		);
		const budget: { maxCallUsd: Record<string, number> } = JSON.parse(
			readFileSync(join(REPO_ROOT, "factory", "config", "budget.json"), "utf8"),
		);
		expect(roles["reviewer-legal"]).toBe("sonnet");
		expect(budget.maxCallUsd["reviewer-legal"]).toBe(0.5);
	});
});
