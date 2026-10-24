import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXPECTED_CLAUDE_VERSION } from "../src/config/compatibility.js";
import { loadConfig } from "../src/config/env.js";
import { type CommandRunner, runDoctor } from "../src/modules/doctor/run-doctor.js";
import { err, ok } from "../src/shared/result.js";
import { createEnv, makeTempDir, writePrd } from "./helpers/env.js";

const ROOT = join(import.meta.dirname, "..");

const runnerFor =
	(table: Record<string, string | undefined>): CommandRunner =>
	async (bin) => {
		const output = table[bin];
		return output === undefined
			? err({ code: "not_found", message: `${bin} not found` })
			: ok({ stdout: output });
	};

const baseDeps = (exec: CommandRunner, factoryHome = makeTempDir()) => ({
	exec,
	nodeVersion: "22.23.2",
	factoryHome,
	expectedClaudeVersion: EXPECTED_CLAUDE_VERSION,
	provider: { kind: "claude" } as const,
	runnerPreference: "auto" as const,
	checkMigrations: () => ok([1, 2, 3, 4, 5]),
	expectedMigrations: [1, 2, 3, 4, 5],
});

const statusOf = (report: Awaited<ReturnType<typeof runDoctor>>, name: string) =>
	report.checks.find((check) => check.name === name)?.status;

describe("config", () => {
	it("defaults FACTORY_HOME to <cwd>/.factory and validates input", () => {
		const config = loadConfig({}, "/work/proj");
		expect(config).toMatchObject({
			ok: true,
			value: { factoryHome: "/work/proj/.factory", claudeBin: "claude" },
		});
		const custom = loadConfig({ FACTORY_HOME: "/tmp/fh", FACTORY_CLAUDE_BIN: "/opt/claude" }, "/x");
		expect(custom).toMatchObject({
			ok: true,
			value: { factoryHome: "/tmp/fh", claudeBin: "/opt/claude" },
		});
		expect(loadConfig({ FACTORY_HOME: "" }, "/x")).toMatchObject({
			ok: false,
			error: { code: "invalid_config" },
		});
	});

	it("keeps the expected Claude CLI version in sync with the compatibility matrix", () => {
		const matrix = readFileSync(join(ROOT, "docs/compatibility/matrix.md"), "utf8");
		expect(matrix).toContain(`| Claude Code CLI | ${EXPECTED_CLAUDE_VERSION} |`);
	});
});

describe("doctor", () => {
	it("passes with everything present and the expected claude version", async () => {
		const report = await runDoctor(
			baseDeps(
				runnerFor({
					git: "git version 2.34.1",
					claude: `${EXPECTED_CLAUDE_VERSION} (Claude Code)`,
					docker: "Docker 29",
					playwright: "Version 1.5",
				}),
			),
		);
		expect(report.hasFailure).toBe(false);
		expect(report.checks.every((c) => c.status === "ok")).toBe(true);
	});

	it("checks the pinned Playwright Docker image instead of a host install", async () => {
		const report = await runDoctor(
			baseDeps(
				runnerFor({
					git: "git version 2.34.1",
					claude: `${EXPECTED_CLAUDE_VERSION} (Claude Code)`,
					docker: "sha256:abc",
				}),
			),
		);
		const playwright = report.checks.find((c) => c.name === "playwright");
		expect(playwright?.status).toBe("ok");
		expect(playwright?.detail).toContain("mcr.microsoft.com/playwright");
	});

	it("warns on claude version mismatch and missing docker/playwright without failing", async () => {
		const report = await runDoctor(
			baseDeps(runnerFor({ git: "git version 2.34.1", claude: "2.9.9 (Claude Code)" })),
		);
		expect(statusOf(report, "claude")).toBe("warn");
		expect(statusOf(report, "docker")).toBe("warn");
		expect(statusOf(report, "playwright")).toBe("warn");
		expect(report.hasFailure).toBe(false);
	});

	it("fails hard on old node, missing git, missing claude, unwritable home or pending migrations", async () => {
		const exec = runnerFor({});
		const blocker = writePrd(makeTempDir());
		const report = await runDoctor({
			...baseDeps(exec, join(blocker, "home")),
			nodeVersion: "20.1.0",
			checkMigrations: () => ok([]),
		});
		for (const name of ["node", "git", "claude", "factory-home", "migrations"]) {
			expect(statusOf(report, name), name).toBe("fail");
		}
		expect(report.hasFailure).toBe(true);
	});

	it("runs against a real storage through createEnv", () => {
		expect(createEnv().storage.appliedMigrations()).toEqual([1, 2, 3, 4, 5, 6, 7]);
	});
});

describe("provider configuration", () => {
	it("defaults to the real provider and the 60 KB context pack limit", () => {
		expect(loadConfig({}, "/x", "/repo")).toMatchObject({
			ok: true,
			value: { provider: { kind: "claude" }, contextPackMaxBytes: 61440, repoRoot: "/repo" },
		});
	});

	it("enables the fake provider only with an explicit fixtures directory", () => {
		expect(loadConfig({ FACTORY_PROVIDER: "fake" }, "/x")).toMatchObject({
			ok: false,
			error: { code: "invalid_config" },
		});
		expect(
			loadConfig({ FACTORY_PROVIDER: "fake", FACTORY_FAKE_FIXTURES: "fx" }, "/work"),
		).toMatchObject({
			ok: true,
			value: { provider: { kind: "fake", fixturesDir: "/work/fx" } },
		});
		expect(loadConfig({ FACTORY_FAKE_FIXTURES: "fx" }, "/work")).toMatchObject({
			ok: true,
			value: { provider: { kind: "claude" } },
		});
		expect(loadConfig({ FACTORY_PROVIDER: "other" }, "/x").ok).toBe(false);
	});

	it("validates the context pack limit", () => {
		expect(loadConfig({ FACTORY_CONTEXT_PACK_MAX_BYTES: "1000" }, "/x")).toMatchObject({
			ok: true,
			value: { contextPackMaxBytes: 1000 },
		});
		expect(loadConfig({ FACTORY_CONTEXT_PACK_MAX_BYTES: "-5" }, "/x").ok).toBe(false);
		expect(loadConfig({ FACTORY_CONTEXT_PACK_MAX_BYTES: "abc" }, "/x").ok).toBe(false);
	});

	it("doctor warns loudly when the fake provider is enabled", async () => {
		const report = await runDoctor({
			...baseDeps(runnerFor({ git: "git version 2.43.0", claude: "2.1.258" })),
			provider: { kind: "fake", fixturesDir: "/fx" },
		});
		const provider = report.checks.find((c) => c.name === "provider");
		expect(provider).toMatchObject({ status: "warn" });
		expect(provider?.detail).toContain("FAKE provider enabled");
		expect(report.hasFailure).toBe(false);
	});
});

describe("runner selection in config and doctor", () => {
	it("reads FACTORY_RUNNER and defaults to auto", () => {
		expect(loadConfig({}, "/x")).toMatchObject({ ok: true, value: { runnerPreference: "auto" } });
		expect(loadConfig({ FACTORY_RUNNER: "host" }, "/x")).toMatchObject({
			ok: true,
			value: { runnerPreference: "host" },
		});
		expect(loadConfig({ FACTORY_RUNNER: "vm" }, "/x")).toMatchObject({
			ok: false,
			error: { code: "invalid_config" },
		});
	});

	it("exposes only a whitelist of environment variables to subprocesses", () => {
		const config = loadConfig(
			{ PATH: "/bin", HOME: "/home/u", ANTHROPIC_API_KEY: "sk-secret", DOCKER_HOST: "unix:///x" },
			"/x",
		);
		expect(config.ok && config.value.subprocessEnv).toEqual({
			PATH: "/bin",
			HOME: "/home/u",
			DOCKER_HOST: "unix:///x",
		});
	});

	it("reports the docker runner as ok when docker info works", async () => {
		const report = await runDoctor(
			baseDeps(runnerFor({ git: "git version 2.40.0", claude: "2.1.258", docker: "Docker 29" })),
		);
		expect(statusOf(report, "runner")).toBe("ok");
		expect(report.checks.find((c) => c.name === "runner")?.detail).toContain("docker");
	});

	it("warns that the host runner has no isolation", async () => {
		const report = await runDoctor({
			...baseDeps(runnerFor({ git: "git version 2.40.0", claude: "2.1.258", docker: "Docker 29" })),
			runnerPreference: "host",
		});
		expect(statusOf(report, "runner")).toBe("warn");
		expect(report.checks.find((c) => c.name === "runner")?.detail).toMatch(/without isolation/);
	});

	it("falls back to host with a warning when docker is unavailable (auto)", async () => {
		const report = await runDoctor(
			baseDeps(runnerFor({ git: "git version 2.40.0", claude: "2.1.258" })),
		);
		expect(statusOf(report, "runner")).toBe("warn");
		expect(report.checks.find((c) => c.name === "runner")?.detail).toMatch(/without isolation/);
	});

	it("fails when docker is required but unavailable", async () => {
		const report = await runDoctor({
			...baseDeps(runnerFor({ git: "git version 2.40.0", claude: "2.1.258" })),
			runnerPreference: "docker",
		});
		expect(statusOf(report, "runner")).toBe("fail");
		expect(report.hasFailure).toBe(true);
	});
});
