import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bootstrapProduct } from "../src/modules/execution/bootstrap-product.js";
import type { TemplateStore } from "../src/modules/execution/ports.js";
import { transitionRun } from "../src/modules/runs/transition-run.js";
import { sha256Of } from "../src/shared/hash.js";
import { fail, ok } from "../src/shared/result.js";
import { makeTempDir } from "./helpers/env.js";
import { createExecEnv, FULLSTACK, gitEnv, seedPlanningRun } from "./helpers/exec-env.js";

const git = (cwd: string, ...args: string[]) =>
	spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv }).stdout.trim();

const listFiles = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.name === ".git"
			? []
			: entry.isDirectory()
				? listFiles(join(dir, entry.name)).map((f) => `${entry.name}/${f}`)
				: [entry.name],
	);

const value = <T>(
	r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } },
): T => {
	if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
	return r.value;
};

describe("bootstrapProduct", () => {
	it("scaffolds the fullstack template into a new target with one engine commit", () => {
		const { env, deps } = createExecEnv();
		const { runId, target } = seedPlanningRun(env, {
			presetIds: FULLSTACK,
			projectName: 'Turno "Local"',
		});
		const summary = value(bootstrapProduct(deps, { runId }));
		expect(summary).toMatchObject({ templateId: "fullstack-kimmbo", skipped: false });
		expect(git(target, "rev-list", "--count", "HEAD")).toBe("1");
		expect(git(target, "log", "-1", "--format=%s")).toBe("chore: scaffold from fullstack-kimmbo");
		expect(git(target, "rev-parse", "HEAD")).toBe(summary.commitSha);
		expect(git(target, "branch", "--show-current")).toBe("main");
		expect(git(target, "status", "--porcelain")).toBe("");
		expect(git(target, "config", "--local", "user.name")).toBe("Gregory Software Factory");
		expect(git(target, "config", "--local", "user.email")).toBe("factory@localhost");
		const files = listFiles(target);
		expect(files).toEqual(
			expect.arrayContaining([
				"package.json",
				"package-lock.json",
				"api/package.json",
				"api/src/server.ts",
				"web/package.json",
				"AGENTS.md",
				"docs/STATE.md",
				".gitignore",
				".nvmrc",
			]),
		);
		expect(files).not.toContain("template.json");
		expect(files.some((f) => f.includes("node_modules"))).toBe(false);
		const agents = readFileSync(join(target, "AGENTS.md"), "utf8");
		expect(agents).toContain("Turno Local");
		expect(agents).not.toContain("{{");
		expect(readFileSync(join(target, "web/src/config/product.ts"), "utf8")).toContain(
			'"Turno Local"',
		);
		const apiEnv = readFileSync(join(target, "api/.env.example"), "utf8");
		expect(apiEnv).toContain("/turno_local_test");
		expect(apiEnv).not.toContain("{{");
		expect(readFileSync(join(target, ".env.example"), "utf8")).toContain("POSTGRES_DB=turno_local");
	});

	it("records the bootstrap artifact and the product.bootstrapped event with the commit sha", () => {
		const { env, deps } = createExecEnv();
		const { runId } = seedPlanningRun(env, { presetIds: FULLSTACK });
		const summary = value(bootstrapProduct(deps, { runId }));
		const events = env.storage.events
			.list(runId, {})
			.filter((e) => e.type === "product.bootstrapped");
		expect(events).toHaveLength(1);
		expect(events[0]?.payload).toMatchObject({
			templateId: "fullstack-kimmbo",
			commitSha: summary.commitSha,
		});
		const artifact = env.storage.artifacts.latest(runId, "bootstrap", "");
		expect(artifact).toBeDefined();
		const stored = env.artifactStore.read(runId, artifact?.path ?? "");
		const content = value(stored);
		expect(sha256Of(content)).toBe(artifact?.sha256);
		expect(JSON.parse(content.toString("utf8"))).toMatchObject({ commitSha: summary.commitSha });
	});

	it("renders the static landing template for the static preset", () => {
		const { env, deps } = createExecEnv();
		const { runId, target } = seedPlanningRun(env, { presetIds: ["static-landing"] });
		expect(value(bootstrapProduct(deps, { runId })).templateId).toBe("static-landing");
		expect(readFileSync(join(target, "index.html"), "utf8")).toContain(
			"<title>turno-local</title>",
		);
		expect(existsSync(join(target, "scripts", "check.mjs"))).toBe(true);
	});

	it("accepts an existing empty directory", () => {
		const { env, deps } = createExecEnv();
		const target = makeTempDir();
		const { runId } = seedPlanningRun(env, { presetIds: ["static-landing"], target });
		expect(bootstrapProduct(deps, { runId }).ok).toBe(true);
	});

	it("is idempotent: a second run is skipped and writes nothing", () => {
		const { env, deps } = createExecEnv();
		const { runId, target } = seedPlanningRun(env, { presetIds: FULLSTACK });
		const first = value(bootstrapProduct(deps, { runId }));
		const eventsBefore = env.storage.events.list(runId, {}).length;
		const second = value(bootstrapProduct(deps, { runId }));
		expect(second).toMatchObject({ skipped: true, commitSha: first.commitSha });
		expect(env.storage.events.list(runId, {}).length).toBe(eventsBefore);
		expect(git(target, "rev-list", "--count", "HEAD")).toBe("1");
	});

	it("fails with bootstrap_inconsistent when the recorded commit no longer exists", () => {
		const { env, deps, git: adapter } = createExecEnv();
		const { runId, target } = seedPlanningRun(env, { presetIds: FULLSTACK });
		value(bootstrapProduct(deps, { runId }));
		rmSync(join(target, ".git"), { recursive: true, force: true });
		adapter.init(target, "main");
		const again = bootstrapProduct(deps, { runId });
		expect(again).toMatchObject({ ok: false, error: { code: "bootstrap_inconsistent" } });
	});

	it("rejects a non-empty non-git target and writes nothing", () => {
		const { env, deps } = createExecEnv();
		const target = makeTempDir();
		const { runId } = seedPlanningRun(env, { presetIds: FULLSTACK, target });
		writeFileSync(join(target, "mine.txt"), "mine");
		expect(bootstrapProduct(deps, { runId })).toMatchObject({
			ok: false,
			error: { code: "target_not_empty" },
		});
		expect(readdirSync(target)).toEqual(["mine.txt"]);
	});

	it("rejects an existing git repository with existing_repo_unsupported", () => {
		const { env, deps, git: adapter } = createExecEnv();
		const target = makeTempDir();
		const { runId } = seedPlanningRun(env, { presetIds: FULLSTACK, target });
		adapter.init(target, "main");
		expect(bootstrapProduct(deps, { runId })).toMatchObject({
			ok: false,
			error: { code: "existing_repo_unsupported" },
		});
		expect(readdirSync(target)).toEqual([".git"]);
	});

	it("requires the run to be in PLANNING", () => {
		const { env, deps } = createExecEnv();
		const { runId } = seedPlanningRun(env, { presetIds: FULLSTACK });
		transitionRun(env, { runId, to: "BLOCKED" });
		expect(bootstrapProduct(deps, { runId })).toMatchObject({
			ok: false,
			error: { code: "run_not_planning" },
		});
		expect(bootstrapProduct(deps, { runId: "run_missing" })).toMatchObject({
			ok: false,
			error: { code: "run_not_found" },
		});
	});

	it("fails without writing when no template satisfies the presets", () => {
		const { env, deps } = createExecEnv();
		const { runId, target } = seedPlanningRun(env, { presetIds: ["web-react-vite"] });
		expect(bootstrapProduct(deps, { runId })).toMatchObject({
			ok: false,
			error: { code: "no_template_for_presets" },
		});
		expect(existsSync(target)).toBe(false);
	});

	it("TOCTOU: a target swapped to a symlink into the factory home before bootstrap is rejected", () => {
		const { env, deps } = createExecEnv();
		const base = makeTempDir();
		const target = join(base, "product");
		const { runId } = seedPlanningRun(env, { presetIds: FULLSTACK, target });
		symlinkSync(env.factoryHome, target);
		expect(bootstrapProduct(deps, { runId })).toMatchObject({
			ok: false,
			error: { code: "target_inside_factory" },
		});
		expect(existsSync(join(env.factoryHome, "AGENTS.md"))).toBe(false);
		expect(existsSync(join(env.factoryHome, ".git"))).toBe(false);
	});

	it("TOCTOU: a swap right before the move is detected and nothing is moved", () => {
		const { env, deps } = createExecEnv();
		const base = makeTempDir();
		const target = join(base, "product");
		const { runId } = seedPlanningRun(env, { presetIds: FULLSTACK, target });
		const real = deps.targets;
		let calls = 0;
		const guarded = {
			...deps,
			targets: {
				resolve: real.resolve,
				revalidate: (path: string) => {
					calls += 1;
					if (calls === 1) symlinkSync(env.factoryHome, target);
					return real.revalidate(path);
				},
			},
		};
		const result = bootstrapProduct(guarded, { runId });
		expect(result).toMatchObject({ ok: false, error: { code: "target_inside_factory" } });
		expect(existsSync(join(env.factoryHome, ".git"))).toBe(false);
		expect(existsSync(join(env.factoryHome, "package.json"))).toBe(false);
		expect(env.storage.events.list(runId, {}).some((e) => e.type === "product.bootstrapped")).toBe(
			false,
		);
	});

	it("blocks the commit when a template file contains a secret and never touches the target", () => {
		const { env, deps } = createExecEnv();
		const { runId, target } = seedPlanningRun(env, { presetIds: ["static-landing"] });
		const leaky: TemplateStore = {
			load: () =>
				ok({
					manifest: { id: "static-landing", presetIds: ["static-landing"], render: [] },
					files: [
						{ path: "index.html", content: Buffer.from("<html></html>") },
						{ path: ".env", content: Buffer.from("TOKEN=abcdefghijklmnop") },
					],
				}),
		};
		const result = bootstrapProduct({ ...deps, templates: leaky }, { runId });
		expect(result).toMatchObject({ ok: false, error: { code: "secret_detected" } });
		if (!result.ok) expect(result.error.message).not.toContain("abcdefghijklmnop");
		expect(existsSync(target)).toBe(false);
		expect(env.storage.events.list(runId, {}).some((e) => e.type === "product.bootstrapped")).toBe(
			false,
		);
	});

	it("crash before the move: the staging area is discarded and rebuilt on the next run", () => {
		const { env, deps } = createExecEnv();
		const { runId, target } = seedPlanningRun(env, { presetIds: ["static-landing"] });
		const crashing = {
			...deps,
			writer: {
				...deps.writer,
				renameDirectory: () =>
					fail("target_write_failed" as const, "injected crash before the move"),
			},
		};
		expect(bootstrapProduct(crashing, { runId }).ok).toBe(false);
		expect(existsSync(target)).toBe(false);
		const staging = join(env.factoryHome, "runs", runId, "staging");
		expect(existsSync(join(staging, ".git"))).toBe(true);
		const summary = value(bootstrapProduct(deps, { runId }));
		expect(summary).toMatchObject({ skipped: false, recovered: false });
		expect(git(target, "rev-list", "--count", "HEAD")).toBe("1");
		expect(git(target, "rev-parse", "HEAD")).toBe(summary.commitSha);
		expect(existsSync(staging)).toBe(false);
		expect(
			env.storage.events.list(runId, {}).filter((e) => e.type === "product.bootstrapped"),
		).toHaveLength(1);
	});

	it("crash after the move but before the event: the next run completes the event", () => {
		const { env, deps, git: adapter } = createExecEnv();
		const { runId, target } = seedPlanningRun(env, { presetIds: ["static-landing"] });
		let transactions = 0;
		const crashing = {
			...deps,
			storage: {
				...env.storage,
				transaction: ((work: () => never) => {
					transactions += 1;
					return transactions === 2
						? fail("storage_error", "injected crash after the move")
						: env.storage.transaction(work);
				}) as typeof env.storage.transaction,
			},
		};
		expect(bootstrapProduct(crashing, { runId })).toMatchObject({
			ok: false,
			error: { code: "storage_error" },
		});
		expect(existsSync(join(target, ".git"))).toBe(true);
		expect(env.storage.events.list(runId, {}).some((e) => e.type === "product.bootstrapped")).toBe(
			false,
		);
		const head = value(adapter.headSha(target));
		const summary = value(bootstrapProduct(deps, { runId }));
		expect(summary).toMatchObject({ skipped: false, recovered: true, commitSha: head });
		expect(git(target, "rev-list", "--count", "HEAD")).toBe("1");
		expect(
			env.storage.events.list(runId, {}).filter((e) => e.type === "product.bootstrapped"),
		).toHaveLength(1);
		expect(value(bootstrapProduct(deps, { runId })).skipped).toBe(true);
	});

	it("does not recover a moved repository whose .git/config was changed after staging", () => {
		const { env, deps } = createExecEnv();
		const { runId, target } = seedPlanningRun(env, { presetIds: ["static-landing"] });
		let transactions = 0;
		const crashing = {
			...deps,
			storage: {
				...env.storage,
				transaction: ((work: () => never) => {
					transactions += 1;
					return transactions === 2
						? fail("storage_error", "injected")
						: env.storage.transaction(work);
				}) as typeof env.storage.transaction,
			},
		};
		bootstrapProduct(crashing, { runId });
		appendFileSync(join(target, ".git", "config"), "[core]\n\tfsmonitor = true\n");
		expect(bootstrapProduct(deps, { runId })).toMatchObject({
			ok: false,
			error: { code: "repo_config_tampered" },
		});
	});

	it("falls back to copy + verification when the staging area is on another device", () => {
		const { env, deps } = createExecEnv();
		const { runId, target } = seedPlanningRun(env, { presetIds: ["static-landing"] });
		const exdev = {
			...deps,
			writer: {
				...deps.writer,
				renameDirectory: () => fail("cross_device" as const, "EXDEV"),
			},
		};
		const summary = value(bootstrapProduct(exdev, { runId }));
		expect(git(target, "rev-parse", "HEAD")).toBe(summary.commitSha);
		expect(git(target, "status", "--porcelain")).toBe("");
		expect(existsSync(join(env.factoryHome, "runs", runId, "staging"))).toBe(false);
	});

	it("rejects a cross-device copy that does not match the staged commit", () => {
		const { env, deps } = createExecEnv();
		const { runId, target } = seedPlanningRun(env, { presetIds: ["static-landing"] });
		const corrupting = {
			...deps,
			writer: {
				...deps.writer,
				renameDirectory: () => fail("cross_device" as const, "EXDEV"),
				copyDirectory: (from: string, to: string) => {
					const copied = deps.writer.copyDirectory(from, to);
					writeFileSync(join(to, "index.html"), "corrupted");
					return copied;
				},
			},
		};
		expect(bootstrapProduct(corrupting, { runId })).toMatchObject({
			ok: false,
			error: { code: "bootstrap_copy_mismatch" },
		});
		expect(env.storage.events.list(runId, {}).some((e) => e.type === "product.bootstrapped")).toBe(
			false,
		);
		expect(existsSync(target)).toBe(true);
	});

	it("keeps the mkdir recursive when the target parent is new", () => {
		const { env, deps } = createExecEnv();
		const target = join(makeTempDir(), "a", "b", "product");
		const { runId } = seedPlanningRun(env, { presetIds: ["static-landing"], target });
		expect(bootstrapProduct(deps, { runId }).ok).toBe(true);
		expect(existsSync(join(target, ".git"))).toBe(true);
		mkdirSync(join(target, "x"), { recursive: true });
	});
});
