import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXIT_PAUSED, runCli } from "../src/cli/program.js";
import { loadConfig } from "../src/config/env.js";
import { buildRun } from "../src/modules/execution/build-run.js";
import { completed, createBuildEnv, greenImpl, redTest, task } from "./helpers/build-env.js";
import { makeTempDir, REPO_ROOT } from "./helpers/env.js";

const cli = async (home: string, args: string[]) => {
	const config = loadConfig(
		{ FACTORY_HOME: home, FACTORY_RUNNER: "host", PATH: process.env.PATH, HOME: process.env.HOME },
		home,
		REPO_ROOT,
	);
	if (!config.ok) throw new Error(config.error.message);
	const out: string[] = [];
	const error: string[] = [];
	const code = await runCli(args, config.value, {
		out: (line) => out.push(line),
		error: (line) => error.push(line),
	});
	return { code, out: out.join("\n"), error: error.join("\n") };
};

describe("delivery commands", () => {
	it("exposes a distinct pause exit code", () => {
		expect(EXIT_PAUSED).toBe(3);
	});

	it("report prints the Spanish traceability report and its JSON form for a built run", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [completed(redTest("add")), completed(greenImpl("add"))],
		});
		const built = await buildRun(env.deps, { runId: env.runId });
		expect(built.ok).toBe(true);
		const text = await cli(env.home, ["report", env.runId]);
		expect(text.code).toBe(0);
		expect(text.out).toContain(`# Informe de la factory: run ${env.runId}`);
		expect(text.out).toContain("REQ-001");
		const json = await cli(env.home, ["report", env.runId, "--json"]);
		expect(JSON.parse(json.out)).toMatchObject({ runId: env.runId, state: "READY_FOR_RELEASE" });
		const status = await cli(env.home, ["status", env.runId]);
		expect(status.out).toContain("Delivery: local, not_started");
		expect(status.out).toContain("factory deliver");
	});

	it("fails with a clear error for unknown runs", async () => {
		const home = makeTempDir();
		for (const args of [
			["report", "nope"],
			["deliver", "nope"],
			["release", "prepare", "nope"],
		]) {
			const result = await cli(home, args);
			expect(result.code, args.join(" ")).toBe(1);
			expect(result.error).toContain("run_not_found");
		}
	});

	it("rejects missing or invalid options with the usage exit code", async () => {
		const home = makeTempDir();
		expect((await cli(home, ["run", "--target", "x"])).code).toBe(2);
		expect(
			(await cli(home, ["run", "--prd", "p", "--target", "x", "--budget-usd", "0"])).code,
		).toBe(2);
		expect((await cli(home, ["audit"])).code).toBe(2);
	});

	it("audit is read-only on a repository with uncommitted and untracked files and reports skipped checks without package.json", async () => {
		const home = makeTempDir();
		const repo = mkdtempSync(join(tmpdir(), "audit-cli-"));
		const git = (...args: string[]) =>
			spawnSync("git", args, {
				cwd: repo,
				encoding: "utf8",
				env: { PATH: process.env.PATH ?? "", HOME: repo },
			});
		git("init", "-q", "-b", "main");
		git("config", "user.email", "t@t");
		git("config", "user.name", "t");
		mkdirSync(join(repo, "src"));
		writeFileSync(join(repo, "src", "a.txt"), "a\n");
		git("add", "-A");
		git("commit", "-q", "-m", "init");
		writeFileSync(join(repo, "src", "a.txt"), "changed\n");
		writeFileSync(join(repo, "scratch.txt"), "x\n");
		const before = git("status", "--porcelain=v2", "--untracked-files=all").stdout;
		const result = await cli(home, ["audit", "--target", repo, "--json"]);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.out)).toMatchObject({ result: "skipped", checkMode: "skipped" });
		expect(git("status", "--porcelain=v2", "--untracked-files=all").stdout).toBe(before);
		const notRepo = await cli(home, ["audit", "--target", makeTempDir()]);
		expect(notRepo.code).toBe(1);
		expect(notRepo.error).toContain("audit_target_not_repo");
	});
});
