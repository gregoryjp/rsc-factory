import { execFile } from "node:child_process";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./helpers/env.js";

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, "..");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");

const FIXTURES = join(ROOT, "test", "fixtures", "demo");

const factory = async (home: string, args: string[], extraEnv: Record<string, string> = {}) => {
	try {
		const { stdout, stderr } = await run(TSX, ["src/cli/main.ts", ...args], {
			cwd: ROOT,
			env: { ...process.env, FACTORY_HOME: home, ...extraEnv },
		});
		return { code: 0, stdout, stderr };
	} catch (cause) {
		const failed = cause as { code?: number; stdout?: string; stderr?: string };
		return { code: failed.code ?? -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
	}
};

describe("CLI smoke", () => {
	it("start -> status -> cancel -> status on the demo PRD", async () => {
		const home = makeTempDir();
		const target = join(makeTempDir(), "product");
		const started = await factory(home, [
			"start",
			"--prd",
			"templates/PRD-DEMO.md",
			"--target",
			target,
			"--json",
		]);
		expect(started.code).toBe(0);
		const { runId, reused } = JSON.parse(started.stdout);
		expect(reused).toBe(false);
		expect(existsSync(join(home, "runs", runId, "input", "prd.md"))).toBe(true);

		const again = await factory(home, [
			"start",
			"--prd",
			"templates/PRD-DEMO.md",
			"--target",
			target,
			"--json",
		]);
		expect(JSON.parse(again.stdout)).toMatchObject({ runId, reused: true });
		const forced = await factory(home, [
			"start",
			"--prd",
			"templates/PRD-DEMO.md",
			"--target",
			target,
			"--new",
			"--json",
		]);
		expect(JSON.parse(forced.stdout).runId).not.toBe(runId);

		const status = await factory(home, ["status", runId, "--json"]);
		expect(JSON.parse(status.stdout).run.state).toBe("CREATED");

		const canceled = await factory(home, ["cancel", runId]);
		expect(canceled.code).toBe(0);
		const after = await factory(home, ["status", runId, "--json"]);
		expect(JSON.parse(after.stdout).run.state).toBe("CANCELED");

		const resume = await factory(home, ["resume", runId]);
		expect(resume.code).toBe(1);
		const human = await factory(home, ["status", runId]);
		expect(human.stdout).toContain("CANCELED");
	});

	it("exits non-zero with a message for unknown runs and missing PRDs", async () => {
		const home = makeTempDir();
		expect((await factory(home, ["status", "run_nope"])).code).toBe(1);
		const target = join(makeTempDir(), "product");
		expect(
			(await factory(home, ["start", "--prd", "templates/missing.md", "--target", target])).code,
		).toBe(1);
		expect((await factory(home, ["start", "--prd", "templates/PRD-DEMO.md"])).code).toBe(2);
		expect((await factory(home, ["start"])).code).toBe(2);
	});
});

const fakeEnv = { FACTORY_PROVIDER: "fake", FACTORY_FAKE_FIXTURES: FIXTURES };

describe("CLI budget", () => {
	it("start --budget-usd sets the budget, status shows it and budget --add raises it", async () => {
		const home = makeTempDir();
		const target = join(makeTempDir(), "product");
		const started = await factory(home, [
			"start",
			"--prd",
			"templates/PRD-DEMO.md",
			"--target",
			target,
			"--budget-usd",
			"4.5",
			"--json",
		]);
		expect(started.code).toBe(0);
		const { runId } = JSON.parse(started.stdout);
		const status = JSON.parse((await factory(home, ["status", runId, "--json"])).stdout);
		expect(status.budget).toMatchObject({ budgetUsd: 4.5, remainingUsd: 4.5, reservedUsd: 0 });
		expect(status.quotaWait).toBeNull();

		const added = await factory(home, ["budget", runId, "--add", "2", "--json"]);
		expect(added.code).toBe(0);
		expect(JSON.parse(added.stdout)).toMatchObject({ budgetUsd: 6.5, unblocked: false });
		const text = await factory(home, ["status", runId]);
		expect(text.stdout).toContain("Budget: 6.5 USD");
		expect(text.stdout).toContain("remaining 6.5");
	});

	it("uses the default budget from factory/config/budget.json and rejects bad amounts", async () => {
		const home = makeTempDir();
		const target = join(makeTempDir(), "product");
		const started = await factory(home, [
			"start",
			"--prd",
			"templates/PRD-DEMO.md",
			"--target",
			target,
			"--json",
		]);
		const { runId } = JSON.parse(started.stdout);
		const status = JSON.parse((await factory(home, ["status", runId, "--json"])).stdout);
		expect(status.budget.budgetUsd).toBe(15);
		expect((await factory(home, ["budget", runId, "--add", "0"])).code).toBe(2);
		expect((await factory(home, ["budget", "run_nope", "--add", "1"])).code).toBe(1);
	});
});

describe("CLI planning with the fake provider", () => {
	it("start --target, plan, status and an idempotent second plan", async () => {
		const home = makeTempDir();
		const target = join(makeTempDir(), "product");
		const started = await factory(home, [
			"start",
			"--prd",
			"templates/PRD-DEMO.md",
			"--target",
			target,
			"--json",
		]);
		const { runId } = JSON.parse(started.stdout);

		const planned = await factory(home, ["plan", runId, "--json"], fakeEnv);
		expect(planned.code).toBe(0);
		expect(planned.stderr).toContain("FAKE provider");
		expect(JSON.parse(planned.stdout)).toMatchObject({
			state: "PLANNING",
			providerCalls: 3,
			taskCount: 6,
			provider: "fake",
		});

		const status = JSON.parse((await factory(home, ["status", runId, "--json"])).stdout);
		expect(status.run.state).toBe("PLANNING");
		expect(status.planning).toMatchObject({
			requirements: 8,
			assumptions: 1,
			contradictions: 0,
			presets: ["backend-express-kimmbo", "web-react-vite"],
		});
		expect(status.taskCounts.READY + status.taskCounts.PENDING).toBe(6);
		const human = await factory(home, ["status", runId]);
		expect(human.stdout).toContain("requirements=8");
		expect(human.stdout).toContain("Preset: backend-express-kimmbo, web-react-vite");

		const again = JSON.parse((await factory(home, ["plan", runId, "--json"], fakeEnv)).stdout);
		expect(again).toMatchObject({ providerCalls: 0, alreadyPlanned: true });
		expect(existsSync(target)).toBe(false);
	});

	it("rejects a target inside the factory repository", async () => {
		const home = makeTempDir();
		const result = await factory(home, [
			"start",
			"--prd",
			"templates/PRD-DEMO.md",
			"--target",
			join(ROOT, "generated-product"),
		]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("target_inside_factory");
	});

	it("fails with an explicit error when a dedup start names another target", async () => {
		const home = makeTempDir();
		const args = ["start", "--prd", "templates/PRD-DEMO.md"];
		await factory(home, [...args, "--target", join(makeTempDir(), "a")]);
		const other = await factory(home, [...args, "--target", join(makeTempDir(), "b")]);
		expect(other.code).toBe(1);
		expect(other.stderr).toContain("target_mismatch");
	});

	it("doctor reports the fake provider as a warning and the real one as ok", async () => {
		const home = makeTempDir();
		const fake = await factory(home, ["doctor"], fakeEnv);
		expect(fake.stdout).toMatch(/WARN provider: FAKE provider enabled/);
		const real = await factory(home, ["doctor"]);
		expect(real.stdout).toMatch(/OK\s+provider: claude/);
	});

	it("refuses to run with FACTORY_PROVIDER=fake and no fixtures", async () => {
		const home = makeTempDir();
		const result = await factory(home, ["doctor"], { FACTORY_PROVIDER: "fake" });
		expect(result.code).toBe(2);
	});
});

describe("CLI build --bootstrap-only with the host runner and the static template", () => {
	const staticFixtures = () => {
		const dir = makeTempDir();
		cpSync(FIXTURES, dir, { recursive: true });
		const architect = JSON.parse(readFileSync(join(dir, "architect.json"), "utf8"));
		architect[0].output.presetIds = ["static-landing"];
		writeFileSync(join(dir, "architect.json"), JSON.stringify(architect));
		return dir;
	};

	const plannedRun = async (home: string, target: string) => {
		const env = {
			FACTORY_PROVIDER: "fake",
			FACTORY_FAKE_FIXTURES: staticFixtures(),
			FACTORY_RUNNER: "host",
		};
		const started = await factory(home, [
			"start",
			"--prd",
			"templates/PRD-DEMO.md",
			"--target",
			target,
			"--json",
		]);
		const { runId } = JSON.parse(started.stdout);
		expect((await factory(home, ["plan", runId], env)).code).toBe(0);
		return { runId, env };
	};

	it("bootstraps, runs the checks, warns about the missing isolation and exits 0", async () => {
		const home = makeTempDir();
		const target = join(makeTempDir(), "product");
		const { runId, env } = await plannedRun(home, target);
		const built = await factory(home, ["build", runId, "--bootstrap-only"], env);
		expect(built.code, built.stderr).toBe(0);
		expect(built.stderr).toContain("without isolation");
		expect(built.stdout).toContain("Bootstrap: template landing");
		expect(built.stdout).toContain("NO ISOLATION");
		expect(built.stdout).toContain("All product checks passed.");
		expect(existsSync(join(target, ".git"))).toBe(true);
		const status = JSON.parse((await factory(home, ["status", runId, "--json"])).stdout);
		expect(status.recentEvents.map((e: { type: string }) => e.type)).toContain("check.recorded");
	});

	it("E05: a failing product check exits 1 and reports that nothing passed", async () => {
		const home = makeTempDir();
		const target = join(makeTempDir(), "product");
		const { runId, env } = await plannedRun(home, target);
		expect((await factory(home, ["build", runId, "--bootstrap-only"], env)).code).toBe(0);
		writeFileSync(join(target, "scripts", "check.mjs"), "process.exit(1);\n");
		const { execFileSync } = await import("node:child_process");
		execFileSync("git", ["add", "-A"], { cwd: target });
		execFileSync("git", ["commit", "-q", "-m", "test: break the check"], { cwd: target });
		const failed = await factory(home, ["build", runId, "--bootstrap-only"], env);
		expect(failed.code).toBe(1);
		expect(failed.stdout).toContain("FAIL npm run check exit=1");
		expect(failed.stdout).toContain("nothing was marked as passed");
	});

	it("rejects non-positive build limits as a usage error", async () => {
		const home = makeTempDir();
		const { runId, env } = await plannedRun(home, join(makeTempDir(), "product"));
		for (const args of [
			["--max-tasks", "0"],
			["--max-provider-calls", "x"],
		]) {
			expect((await factory(home, ["build", runId, ...args], env)).code, args.join(" ")).toBe(2);
		}
	});

	it("refuses to build a run that has not been planned", async () => {
		const home = makeTempDir();
		const { env } = await plannedRun(home, join(makeTempDir(), "product"));
		const started = await factory(
			home,
			[
				"start",
				"--prd",
				"templates/PRD-DEMO.md",
				"--target",
				join(makeTempDir(), "p2"),
				"--new",
				"--json",
			],
			env,
		);
		const { runId } = JSON.parse(started.stdout);
		const built = await factory(home, ["build", runId], env);
		expect(built.code).toBe(1);
		expect(built.stderr).toContain("run_not_buildable");
	});
});

describe("CLI retry", () => {
	it("fails cleanly for an unknown run and documents the command", async () => {
		const home = makeTempDir();
		const unknown = await factory(home, ["retry", "run_nope", "add"]);
		expect(unknown.code).toBe(1);
		expect(unknown.stderr).toContain("run_not_found");
		const help = await factory(home, ["retry", "--help"]);
		expect(help.stdout).toContain("--note");
	});
});
