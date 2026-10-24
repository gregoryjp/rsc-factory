import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diffTargetState } from "../src/domain/audit/target-state.js";
import { captureTargetState } from "../src/infrastructure/fs/target-state.js";
import { createReadOnlyGit } from "../src/infrastructure/git/read-only-git.js";
import type { ScriptedResult } from "../src/infrastructure/providers/fake-provider.js";
import { createScriptedProvider } from "../src/infrastructure/providers/scripted-provider.js";
import { type AuditDeps, auditRepo } from "../src/modules/audit/audit-repo.js";
import type { CheckRunnerPort, RunCheckInput } from "../src/modules/execution/ports.js";
import { sha256Of } from "../src/shared/hash.js";
import { ok } from "../src/shared/result.js";
import { makeTempDir, openEnv } from "./helpers/env.js";
import { gitEnv } from "./helpers/exec-env.js";

const git = (cwd: string, ...args: string[]) => {
	const out = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...gitEnv, HOME: cwd } });
	if (out.status !== 0) throw new Error(out.stderr);
	return out.stdout;
};

const makeRepo = (files: Record<string, string> = {}) => {
	const dir = mkdtempSync(join(tmpdir(), "audit-target-"));
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "t@t");
	git(dir, "config", "user.name", "t");
	const committed = {
		"package.json": '{"name":"p","scripts":{"test":"true"}}\n',
		"src.js": "export const a = 1;\n",
		".gitignore": "ignored.log\n",
		...files,
	};
	for (const [path, content] of Object.entries(committed)) {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "init");
	writeFileSync(join(dir, "src.js"), "export const a = 2; // uncommitted\n");
	writeFileSync(join(dir, "untracked.txt"), "scratch\n");
	writeFileSync(join(dir, "ignored.log"), "noise\n");
	return dir;
};

type RunnerLog = { inputs: RunCheckInput[]; seenSource: string[] };

const fakeRunner = (
	home: string,
	log: RunnerLog,
	hook: (input: RunCheckInput) => void = () => undefined,
	exitCode = 0,
): CheckRunnerPort => ({
	kind: "host",
	isolated: false,
	runCheck: async (input) => {
		log.inputs.push(input);
		log.seenSource.push(readFileSync(join(input.cwd, "src.js"), "utf8"));
		hook(input);
		const logPath = join(home, "runs", input.runId, "checks", `${input.checkId ?? "c"}.log`);
		mkdirSync(join(logPath, ".."), { recursive: true });
		writeFileSync(logPath, "log\n");
		return ok({
			checkId: input.checkId ?? "c",
			exitCode,
			durationMs: 1,
			logPath,
			logSha256: sha256Of("log\n"),
			tail: "",
			timedOut: false,
			killError: null,
			isolated: false,
		});
	},
	teardown: async () => ok(undefined),
});

const reviewOk = (area: string, findings: unknown[] = []): ScriptedResult => ({
	ok: true,
	value: {
		output: {
			area,
			verdict: findings.length === 0 ? "pass" : "findings",
			findings,
			requiresReviewAck: [],
		},
		costUsd: 0.1,
		models: ["fake"],
	},
});

const setup = (
	options: {
		hook?: (input: RunCheckInput) => void;
		exitCode?: number;
		scripts?: Record<string, ScriptedResult[]>;
	} = {},
) => {
	const home = makeTempDir();
	const base = openEnv(home);
	const log: RunnerLog = { inputs: [], seenSource: [] };
	const provider = createScriptedProvider(options.scripts ?? {});
	const deps: AuditDeps = {
		...base,
		provider,
		git: createReadOnlyGit({ factoryHome: home, baseEnv: gitEnv }),
		runner: fakeRunner(home, log, options.hook, options.exitCode),
	};
	return { home, deps, log, provider, storage: base.storage };
};

const fingerprint = (dir: string) => ({
	head: git(dir, "rev-parse", "HEAD"),
	status: git(dir, "status", "--porcelain=v2", "--untracked-files=all"),
	index: sha256Of(readFileSync(join(dir, ".git", "index"))),
	src: readFileSync(join(dir, "src.js"), "utf8"),
});

describe("target state capture and diff", () => {
	it("hashes tracked and untracked files that are not ignored and reports exact differences", () => {
		const dir = makeRepo();
		const readOnly = createReadOnlyGit({ factoryHome: makeTempDir(), baseEnv: gitEnv });
		const before = captureTargetState(readOnly, dir);
		if (!before.ok) throw new Error(before.error.message);
		expect(Object.keys(before.value.files)).toEqual([
			".gitignore",
			"package.json",
			"src.js",
			"untracked.txt",
		]);
		expect(before.value.files["untracked.txt"]).toBe(sha256Of("scratch\n"));
		expect(before.value.status).toContain("untracked.txt");
		writeFileSync(join(dir, "untracked.txt"), "changed\n");
		writeFileSync(join(dir, "new.txt"), "n\n");
		const after = captureTargetState(readOnly, dir);
		if (!after.ok) throw new Error(after.error.message);
		expect(diffTargetState(before.value, after.value)).toEqual({
			headChanged: false,
			statusChanged: true,
			files: [
				{ path: "new.txt", change: "added" },
				{ path: "untracked.txt", change: "modified" },
			],
		});
	});

	it("does not refresh or rewrite the git index while reading", () => {
		const dir = makeRepo();
		const indexPath = join(dir, ".git", "index");
		const stale = new Date(1_000_000_000_000);
		utimesSync(join(dir, "package.json"), stale, stale);
		const before = sha256Of(readFileSync(indexPath));
		const readOnly = createReadOnlyGit({ factoryHome: makeTempDir(), baseEnv: gitEnv });
		captureTargetState(readOnly, dir);
		expect(sha256Of(readFileSync(indexPath))).toBe(before);
	});
});

describe("audit mode (E17)", () => {
	it("leaves HEAD, status, index and every file of the target unchanged, checking a snapshot of HEAD", async () => {
		const dir = makeRepo();
		const { deps, log, home } = setup();
		const before = fingerprint(dir);
		const result = await auditRepo(deps, { target: dir, review: false });
		if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
		const report = result.value;
		expect(report.result).toBe("passed");
		expect(report.checkMode).toBe("generic");
		expect(report.checks.map((c) => c.argv.join(" "))).toEqual(["npm ci", "npm test"]);
		expect(fingerprint(dir)).toEqual(before);
		expect(log.seenSource).toEqual(["export const a = 1;\n", "export const a = 1;\n"]);
		expect(log.inputs[0]?.cwd).toContain(join(home, "audits"));
		expect(existsSync(log.inputs[0]?.cwd ?? "x")).toBe(false);
		expect(report.diff).toEqual({ headChanged: false, statusChanged: false, files: [] });
		expect(report.before.fileCount).toBe(4);
		const written = JSON.parse(
			readFileSync(join(home, "audits", report.auditId, "report.json"), "utf8"),
		);
		expect(written).toMatchObject({ auditId: report.auditId, result: "passed" });
		expect(readFileSync(join(home, "audits", report.auditId, "report.md"), "utf8")).toContain(
			"Auditoría",
		);
		expect(git(dir, "status", "--porcelain=v2", "--untracked-files=all")).toContain(
			"untracked.txt",
		);
	});

	it("detects a writer that mutates the target during the audit and reports target_mutated with the diff", async () => {
		const dir = makeRepo();
		const { deps } = setup({
			hook: () => writeFileSync(join(dir, "injected.txt"), "boom\n"),
		});
		const result = await auditRepo(deps, { target: dir, review: false });
		if (!result.ok) throw new Error(result.error.message);
		expect(result.value.result).toBe("target_mutated");
		expect(result.value.diff.files).toEqual([{ path: "injected.txt", change: "added" }]);
		expect(result.value.diff.statusChanged).toBe(true);
	});

	it("detects a rewritten tracked file even when git status looks the same", async () => {
		const dir = makeRepo();
		const { deps } = setup({
			hook: () => writeFileSync(join(dir, "src.js"), "export const a = 3; // uncommitted\n"),
		});
		const result = await auditRepo(deps, { target: dir, review: false });
		if (!result.ok) throw new Error(result.error.message);
		expect(result.value.result).toBe("target_mutated");
		expect(result.value.diff.files).toEqual([{ path: "src.js", change: "modified" }]);
		expect(result.value.diff.statusChanged).toBe(false);
	});

	it("uses the policy of a detected template id", async () => {
		const dir = makeRepo({
			"template.json": '{"id":"static-landing","presetIds":["x"],"render":[]}\n',
		});
		const { deps } = setup();
		const result = await auditRepo(deps, { target: dir, review: false });
		if (!result.ok) throw new Error(result.error.message);
		expect(result.value).toMatchObject({ checkMode: "template", templateId: "static-landing" });
		expect(result.value.checks.map((c) => c.argv.join(" "))).toEqual(["npm ci", "npm run check"]);
	});

	it("skips the checks with a reason when there is no package.json", async () => {
		const dir = makeRepo();
		git(dir, "rm", "-q", "-f", "package.json");
		git(dir, "commit", "-q", "-m", "drop package.json");
		const { deps, log } = setup();
		const result = await auditRepo(deps, { target: dir, review: false });
		if (!result.ok) throw new Error(result.error.message);
		expect(result.value).toMatchObject({ result: "skipped", checkMode: "skipped" });
		expect(result.value.skipReason).toContain("package.json");
		expect(log.inputs).toHaveLength(0);
	});

	it("reports failed checks without touching the target", async () => {
		const dir = makeRepo();
		const { deps } = setup({ exitCode: 1 });
		const result = await auditRepo(deps, { target: dir, review: false });
		if (!result.ok) throw new Error(result.error.message);
		expect(result.value.result).toBe("checks_failed");
		expect(result.value.checks).toHaveLength(1);
	});

	it("runs the security and code reviewers read-only on a snapshot and counts them under the audit run", async () => {
		const dir = makeRepo();
		const finding = {
			id: "S1",
			severity: "low",
			confidence: "high",
			title: "Hardcoded constant",
			file: "src.js",
			lineStart: 1,
			lineEnd: 1,
			evidence: "const a = 1",
			impact: "none",
			recommendation: "none",
		};
		const { deps, provider, storage } = setup({
			scripts: {
				"reviewer-security": [reviewOk("security")],
				"reviewer-code": [reviewOk("code", [finding])],
			},
		});
		const before = fingerprint(dir);
		const result = await auditRepo(deps, { target: dir, review: true });
		if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
		expect(result.value.reviews?.map((r) => [r.area, r.verdict, r.findings.length])).toEqual([
			["security", "pass", 0],
			["code", "findings", 1],
		]);
		for (const call of provider.calls) {
			expect(call).toMatchObject({ restricted: true, tools: ["Read", "Glob", "Grep"] });
			expect(call.cwd).toContain("audits");
			expect(existsSync(call.cwd)).toBe(false);
		}
		expect(storage.budgets.summary(result.value.runId).callsByRole).toEqual({
			"reviewer-security": 1,
			"reviewer-code": 1,
		});
		expect(result.value.provider).toBe("fake");
		expect(fingerprint(dir)).toEqual(before);
	});

	it("refuses a directory that is not a git repository", async () => {
		const { deps } = setup();
		const result = await auditRepo(deps, { target: makeTempDir(), review: false });
		expect(result).toMatchObject({ ok: false });
	});
});
