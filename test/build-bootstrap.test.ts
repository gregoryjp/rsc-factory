import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isCheckEvidenceValid } from "../src/domain/checks/evidence.js";
import { buildBootstrapOnly } from "../src/modules/execution/build-run.js";
import type {
	CheckOutcome,
	CheckRunnerPort,
	RunCheckInput,
	RunnerError,
} from "../src/modules/execution/ports.js";
import { runAndRecordCheck } from "../src/modules/execution/record-check.js";
import { fail, ok, type Result } from "../src/shared/result.js";
import { makeTempDir } from "./helpers/env.js";
import { commitAll, createExecEnv, FULLSTACK, seedPlanningRun } from "./helpers/exec-env.js";

type Script = (
	input: RunCheckInput,
	index: number,
) => Result<number, RunnerError> | { exitCode: number; effect?: () => void };

const outcome = (input: RunCheckInput, exitCode: number): CheckOutcome => ({
	checkId: input.checkId ?? "chk_fake",
	exitCode,
	durationMs: 42,
	logPath: "/unused",
	logSha256: "c".repeat(64),
	tail: "tail",
	timedOut: false,
	killError: null,
	isolated: true,
});

const fakeRunner = (script: Script) => {
	const calls: RunCheckInput[] = [];
	let tornDown: string[] = [];
	const runner: CheckRunnerPort = {
		kind: "docker",
		isolated: true,
		runCheck: async (input) => {
			calls.push(input);
			const scripted = script(input, calls.length - 1);
			if ("ok" in scripted) return scripted.ok ? ok(outcome(input, scripted.value)) : scripted;
			scripted.effect?.();
			return ok(outcome(input, scripted.exitCode));
		},
		teardown: async (runId) => {
			tornDown = [...tornDown, runId];
			return ok(undefined);
		},
	};
	return { runner, calls, tornDown: () => tornDown };
};

const setup = (script: Script) => {
	const exec = createExecEnv();
	const fake = fakeRunner(script);
	const deps = { ...exec.deps, runner: fake.runner };
	return { ...exec, ...fake, deps };
};

const checkWorkRoot = (home: string, runId: string) => join(home, "runs", runId, "check-work");

const hashOf = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

const baseInput = (runId: string, target: string, argv: string[] = ["true"]) => ({
	runId,
	taskId: null,
	repoDir: target,
	cwdLabel: "product",
	argv,
	env: {},
	timeoutMs: 1000,
});

describe("runAndRecordCheck", () => {
	it("records the check against the commit it archived and keeps evidence commit-bound", async () => {
		const { env, deps, git, calls } = setup(() => ({ exitCode: 3 }));
		const { runId, target } = seedPlanningRun(env, { presetIds: ["static-landing"] });
		const boot = await buildBootstrapOnly(deps, { runId });
		if (!boot.ok) throw new Error(boot.error.message);
		const result = await runAndRecordCheck(deps, baseInput(runId, target, ["node", "-e", "x"]));
		if (!result.ok) throw new Error(result.error.message);
		const head = git.headSha(target);
		if (!head.ok) throw new Error(head.error.message);
		expect(result.value).toMatchObject({
			runId,
			taskId: null,
			argv: ["node", "-e", "x"],
			cwd: "product",
			exitCode: 3,
			commitSha: head.value,
			isolated: true,
		});
		expect(env.storage.checks.get(result.value.id)).toEqual(result.value);
		expect(env.storage.events.list(runId, {}).some((e) => e.type === "check.recorded")).toBe(true);
		expect(isCheckEvidenceValid(result.value, head.value)).toBe(true);
		writeFileSync(join(target, "next.txt"), "next");
		const second = commitAll(git, target, "chore: next");
		if (!second.ok) throw new Error(second.error.message);
		expect(isCheckEvidenceValid(result.value, second.value)).toBe(false);
		expect(calls.at(-1)?.cwd.startsWith(checkWorkRoot(env.factoryHome, runId))).toBe(true);
	});

	it("runs on a snapshot of the commit, never on the live repository", async () => {
		let seen: { cwd: string; hasGit: boolean; index: string; hasDirty: boolean } | undefined;
		const { env, deps, calls } = setup((input) => ({
			exitCode: 0,
			effect: () => {
				seen = {
					cwd: input.cwd,
					hasGit: existsSync(join(input.cwd, ".git")),
					index: readFileSync(join(input.cwd, "index.html"), "utf8"),
					hasDirty: existsSync(join(input.cwd, "dirty.txt")),
				};
			},
		}));
		const { runId, target } = seedPlanningRun(env, { presetIds: ["static-landing"] });
		await buildBootstrapOnly(deps, { runId });
		const committed = readFileSync(join(target, "index.html"), "utf8");
		writeFileSync(join(target, "index.html"), "dirty edit");
		writeFileSync(join(target, "dirty.txt"), "dirty");
		const result = await runAndRecordCheck(deps, baseInput(runId, target));
		expect(result.ok).toBe(true);
		expect(seen?.cwd).not.toBe(target);
		expect(seen?.hasGit).toBe(false);
		expect(seen?.index).toBe(committed);
		expect(seen?.hasDirty).toBe(false);
		expect(calls.at(-1)?.checkId).toBeDefined();
		expect(readdirSync(checkWorkRoot(env.factoryHome, runId))).toEqual([]);
	});

	it("a check that writes .git/config cannot touch the repository or run injected commands", async () => {
		const marker = join(makeTempDir(), "fsmonitor-ran");
		const { env, deps, git } = setup((input) => ({
			exitCode: 0,
			effect: () => {
				mkdirSync(join(input.cwd, ".git"), { recursive: true });
				writeFileSync(join(input.cwd, ".git", "config"), `[core]\n\tfsmonitor = touch ${marker}\n`);
			},
		}));
		const { runId, target } = seedPlanningRun(env, { presetIds: ["static-landing"] });
		await buildBootstrapOnly(deps, { runId });
		const before = hashOf(join(target, ".git", "config"));
		const result = await runAndRecordCheck(deps, baseInput(runId, target));
		expect(result.ok).toBe(true);
		expect(hashOf(join(target, ".git", "config"))).toBe(before);
		expect(git.isClean(target)).toEqual({ ok: true, value: true });
		expect(existsSync(marker)).toBe(false);
		expect(readdirSync(checkWorkRoot(env.factoryHome, runId))).toEqual([]);
	});

	it("removes the snapshot even when the check fails and keeps the log reference", async () => {
		const { env, deps } = setup(() => ({ exitCode: 1 }));
		const { runId, target } = seedPlanningRun(env, { presetIds: ["static-landing"] });
		await buildBootstrapOnly(deps, { runId });
		const result = await runAndRecordCheck(deps, baseInput(runId, target));
		if (!result.ok) throw new Error(result.error.message);
		expect(result.value.exitCode).toBe(1);
		expect(readdirSync(checkWorkRoot(env.factoryHome, runId))).toEqual([]);
	});

	it("propagates runner failures without recording anything and still removes the snapshot", async () => {
		const { env, deps } = setup((_input, index) =>
			index < 2 ? { exitCode: 0 } : fail("runner_failed", "boom"),
		);
		const { runId, target } = seedPlanningRun(env, { presetIds: ["static-landing"] });
		await buildBootstrapOnly(deps, { runId });
		const before = env.storage.checks.listByRun(runId).length;
		const result = await runAndRecordCheck(deps, baseInput(runId, target));
		expect(result).toMatchObject({ ok: false, error: { code: "runner_failed" } });
		expect(env.storage.checks.listByRun(runId).length).toBe(before);
		expect(readdirSync(checkWorkRoot(env.factoryHome, runId))).toEqual([]);
	});

	it("refuses to snapshot a tampered repository", async () => {
		const { env, deps, calls } = setup(() => ({ exitCode: 0 }));
		const { runId, target } = seedPlanningRun(env, { presetIds: ["static-landing"] });
		await buildBootstrapOnly(deps, { runId });
		const before = calls.length;
		writeFileSync(
			join(target, ".git", "config"),
			`${readFileSync(join(target, ".git", "config"), "utf8")}[core]\n\tfsmonitor = true\n`,
		);
		const result = await runAndRecordCheck(deps, baseInput(runId, target));
		expect(result).toMatchObject({ ok: false, error: { code: "repo_config_tampered" } });
		expect(calls.length).toBe(before);
	});

	it("records a failed docker kill in the check event", async () => {
		const { env, deps } = setup(() => ({ exitCode: 0 }));
		const killing: CheckRunnerPort = {
			...deps.runner,
			runCheck: async (input) =>
				ok({ ...outcome(input, 124), timedOut: true, killError: "docker kill failed: gone" }),
		};
		const { runId, target } = seedPlanningRun(env, { presetIds: ["static-landing"] });
		await buildBootstrapOnly(deps, { runId });
		await runAndRecordCheck({ ...deps, runner: killing }, baseInput(runId, target));
		const events = env.storage.events.list(runId, {}).filter((e) => e.type === "check.recorded");
		expect(events.at(-1)?.payload.killError).toBe("docker kill failed: gone");
	});
});

describe("buildBootstrapOnly", () => {
	it("bootstraps, then runs npm ci and npm run check on one snapshot of the product", async () => {
		const { env, deps, calls, tornDown } = setup(() => ({ exitCode: 0 }));
		const { runId } = seedPlanningRun(env, { presetIds: FULLSTACK });
		const built = await buildBootstrapOnly(deps, { runId });
		if (!built.ok) throw new Error(built.error.message);
		expect(built.value.passed).toBe(true);
		expect(built.value.bootstrap.templateId).toBe("apiweb");
		expect(calls.map((c) => c.argv)).toEqual([
			["npm", "ci"],
			["npm", "run", "check"],
		]);
		expect(new Set(calls.map((c) => c.cwd)).size).toBe(1);
		expect(calls[0]?.cwd.startsWith(checkWorkRoot(env.factoryHome, runId))).toBe(true);
		expect(built.value.checks.map((c) => c.exitCode)).toEqual([0, 0]);
		expect(tornDown()).toEqual([runId]);
		expect(env.storage.checks.listByRun(runId)).toHaveLength(2);
		expect(readdirSync(checkWorkRoot(env.factoryHome, runId))).toEqual([]);
	});

	it("E05: a failing check is reported as failed, stops the sequence and marks nothing as passed", async () => {
		const { env, deps, calls, tornDown } = setup((input) => ({
			exitCode: input.argv.join(" ") === "npm run check" ? 1 : 0,
		}));
		const { runId } = seedPlanningRun(env, { presetIds: FULLSTACK });
		const built = await buildBootstrapOnly(deps, { runId });
		if (!built.ok) throw new Error(built.error.message);
		expect(built.value.passed).toBe(false);
		expect(built.value.checks.at(-1)).toMatchObject({ argv: ["npm", "run", "check"], exitCode: 1 });
		expect(env.storage.runs.get(runId)?.state).toBe("PLANNING");
		expect(calls).toHaveLength(2);
		expect(tornDown()).toEqual([runId]);
	});

	it("does not run the check when npm ci fails", async () => {
		const { env, deps, calls } = setup(() => ({ exitCode: 1 }));
		const { runId } = seedPlanningRun(env, { presetIds: FULLSTACK });
		const built = await buildBootstrapOnly(deps, { runId });
		if (!built.ok) throw new Error(built.error.message);
		expect(built.value.passed).toBe(false);
		expect(calls.map((c) => c.argv)).toEqual([["npm", "ci"]]);
	});

	it("tears the runner down even when the bootstrap fails", async () => {
		const { env, deps, tornDown } = setup(() => ({ exitCode: 0 }));
		const { runId } = seedPlanningRun(env, { presetIds: ["web-react-vite"] });
		const built = await buildBootstrapOnly(deps, { runId });
		expect(built).toMatchObject({ ok: false, error: { code: "no_template_for_presets" } });
		expect(tornDown()).toEqual([runId]);
	});

	it("re-running skips the bootstrap and still runs the checks", async () => {
		const { env, deps } = setup(() => ({ exitCode: 0 }));
		const { runId } = seedPlanningRun(env, { presetIds: ["static-landing"] });
		await buildBootstrapOnly(deps, { runId });
		const second = await buildBootstrapOnly(deps, { runId });
		if (!second.ok) throw new Error(second.error.message);
		expect(second.value.bootstrap.skipped).toBe(true);
		expect(second.value.passed).toBe(true);
		expect(env.storage.checks.listByRun(runId)).toHaveLength(4);
	});
});
