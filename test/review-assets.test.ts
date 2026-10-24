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
});
