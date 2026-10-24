import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildClaudeArgs } from "../src/infrastructure/providers/claude-cli-provider.js";
import type { ProviderRequest } from "../src/infrastructure/providers/provider-port.js";
import {
	createScriptedProvider,
	loadFixtureScripts,
} from "../src/infrastructure/providers/scripted-provider.js";
import { makeTempDir } from "./helpers/env.js";

const request = (over: Partial<ProviderRequest> = {}): ProviderRequest => ({
	role: "builder",
	prompt: "p",
	systemPrompt: "s",
	jsonSchema: {},
	model: "sonnet",
	maxBudgetUsd: 2,
	tools: ["Read", "Edit", "Write", "Glob", "Grep"],
	cwd: "/work",
	timeoutMs: 1000,
	restricted: true,
	permissionMode: "acceptEdits",
	...over,
});

const Out = z.object({ status: z.string() });

describe("builder provider profile (ADR 0006)", () => {
	it("passes --restricted, the file tools and acceptEdits, never Bash", () => {
		const argv = buildClaudeArgs(request());
		expect(argv).toContain("--restricted");
		expect(argv[argv.indexOf("--tools") + 1]).toBe("Read,Edit,Write,Glob,Grep");
		expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
		expect(argv.join(" ")).not.toContain("Bash");
		expect(argv[argv.indexOf("--tools") + 1]).not.toBe("");
	});

	it("leaves planning calls untouched", () => {
		const argv = buildClaudeArgs(
			request({ restricted: undefined, permissionMode: undefined, tools: [] }),
		);
		expect(argv).not.toContain("--restricted");
		expect(argv).not.toContain("--permission-mode");
		expect(argv[argv.indexOf("--tools") + 1]).toBe("");
	});
});

describe("scripted provider file edits", () => {
	const script = (edits: { writes?: Record<string, string>; deletes?: string[] }) =>
		createScriptedProvider({
			builder: [
				{
					ok: true,
					value: { output: { status: "completed" }, costUsd: null, models: ["fake"] },
					edits,
				},
			],
		});

	it("writes and deletes files inside the request cwd", async () => {
		const cwd = makeTempDir();
		writeFileSync(join(cwd, "old.txt"), "x");
		const provider = script({ writes: { "a/b.txt": "hello" }, deletes: ["old.txt"] });
		const result = await provider.invoke(request({ cwd }), Out);
		expect(result.ok).toBe(true);
		expect(readFileSync(join(cwd, "a/b.txt"), "utf8")).toBe("hello");
		expect(existsSync(join(cwd, "old.txt"))).toBe(false);
	});

	it("refuses paths that escape the cwd or touch .git", async () => {
		for (const path of ["../escape.txt", "/abs.txt", ".git/config", "a/../../x", "a\\b"]) {
			const cwd = makeTempDir();
			const result = await script({ writes: { [path]: "x" } }).invoke(request({ cwd }), Out);
			expect(result, path).toMatchObject({ ok: false, error: { kind: "provider_error" } });
		}
	});

	it("refuses to write through a symlinked directory", async () => {
		const cwd = makeTempDir();
		const outside = makeTempDir();
		mkdirSync(join(cwd, "d"));
		symlinkSync(outside, join(cwd, "link"));
		const result = await script({ writes: { "link/x.txt": "x" } }).invoke(request({ cwd }), Out);
		expect(result.ok).toBe(false);
		expect(existsSync(join(outside, "x.txt"))).toBe(false);
	});

	it("loads writes and deletes from fixture files", () => {
		const dir = makeTempDir();
		writeFileSync(
			join(dir, "builder.json"),
			JSON.stringify([
				{ output: { status: "completed" }, writes: { "x.txt": "1" }, deletes: ["y"] },
			]),
		);
		const loaded = loadFixtureScripts(dir, ["builder"]);
		if (!loaded.ok) throw new Error(loaded.error.message);
		expect(loaded.value.builder?.[0]).toMatchObject({
			ok: true,
			edits: { writes: { "x.txt": "1" }, deletes: ["y"] },
		});
	});

	it("treats a missing optional fixture as an empty script", () => {
		const loaded = loadFixtureScripts(makeTempDir(), [], ["builder"]);
		expect(loaded).toEqual({ ok: true, value: { builder: [] } });
	});
});
