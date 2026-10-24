import { accessSync, constants, mkdirSync } from "node:fs";
import { MIN_NODE_MAJOR, PLAYWRIGHT_IMAGE } from "../../config/compatibility.js";
import type { ProviderConfig, RunnerPreference } from "../../config/env.js";
import type { Failure, Result } from "../../shared/result.js";

export type CommandRunner = (
	bin: string,
	args: readonly string[],
	timeoutMs: number,
) => Promise<Result<{ stdout: string }, Failure<"not_found" | "failed" | "timeout">>>;

export type CheckStatus = "ok" | "warn" | "fail";
export type DoctorCheck = { name: string; status: CheckStatus; detail: string };
export type DoctorReport = { checks: DoctorCheck[]; hasFailure: boolean };

export type DoctorDeps = {
	exec: CommandRunner;
	nodeVersion: string;
	factoryHome: string;
	expectedClaudeVersion: string;
	provider: ProviderConfig;
	runnerPreference: RunnerPreference;
	checkMigrations: () => Result<number[], Failure<string>>;
	expectedMigrations: number[];
};

const PROBE_TIMEOUT_MS = 10_000;
const VERSION_PATTERN = /\d+\.\d+\.\d+/;

const check = (name: string, status: CheckStatus, detail: string): DoctorCheck => ({
	name,
	status,
	detail,
});

const probe = async (
	deps: DoctorDeps,
	bin: string,
	args: readonly string[],
): Promise<{ found: true; version: string; raw: string } | { found: false; reason: string }> => {
	const result = await deps.exec(bin, args, PROBE_TIMEOUT_MS);
	if (!result.ok) return { found: false, reason: result.error.message };
	const raw = result.value.stdout.trim().split("\n")[0] ?? "";
	return { found: true, version: VERSION_PATTERN.exec(raw)?.[0] ?? "unknown", raw };
};

const checkNode = (deps: DoctorDeps): DoctorCheck => {
	const major = Number.parseInt(deps.nodeVersion.split(".")[0] ?? "", 10);
	return major >= MIN_NODE_MAJOR
		? check("node", "ok", `Node ${deps.nodeVersion}`)
		: check("node", "fail", `Node ${deps.nodeVersion}; requires >= ${MIN_NODE_MAJOR}`);
};

const checkGit = async (deps: DoctorDeps): Promise<DoctorCheck> => {
	const found = await probe(deps, "git", ["--version"]);
	return found.found ? check("git", "ok", found.raw) : check("git", "fail", found.reason);
};

const checkClaude = async (deps: DoctorDeps): Promise<DoctorCheck> => {
	const found = await probe(deps, "claude", ["--version"]);
	if (!found.found) return check("claude", "fail", found.reason);
	return found.version === deps.expectedClaudeVersion
		? check("claude", "ok", `Claude Code ${found.version}`)
		: check(
				"claude",
				"warn",
				`Claude Code ${found.version}; compatibility matrix verified ${deps.expectedClaudeVersion}`,
			);
};

const checkOptional = async (
	deps: DoctorDeps,
	name: string,
	bin: string,
	hint: string,
): Promise<DoctorCheck> => {
	const found = await probe(deps, bin, ["--version"]);
	return found.found
		? check(name, "ok", found.raw)
		: check(name, "warn", `${hint} (${found.reason})`);
};

const checkPlaywrightImage = async (deps: DoctorDeps): Promise<DoctorCheck> => {
	const found = await probe(deps, "docker", [
		"image",
		"inspect",
		"--format",
		"{{.Id}}",
		PLAYWRIGHT_IMAGE,
	]);
	return found.found
		? check("playwright", "ok", `browser image present: ${PLAYWRIGHT_IMAGE}`)
		: check(
				"playwright",
				"warn",
				`browser image not pulled yet (UI review pulls ~2.5 GB on first use; run docker pull ${PLAYWRIGHT_IMAGE})`,
			);
};

const checkProvider = (deps: DoctorDeps): DoctorCheck =>
	deps.provider.kind === "fake"
		? check(
				"provider",
				"warn",
				`FAKE provider enabled (FACTORY_PROVIDER=fake, fixtures: ${deps.provider.fixturesDir}); planning output is scripted, not produced by a model`,
			)
		: check("provider", "ok", "claude (real)");

const checkRunner = async (deps: DoctorDeps): Promise<DoctorCheck> => {
	if (deps.runnerPreference === "host") {
		return check(
			"runner",
			"warn",
			"host (FACTORY_RUNNER=host): generated code runs without isolation",
		);
	}
	const info = await deps.exec(
		"docker",
		["info", "--format", "{{.OperatingSystem}}"],
		PROBE_TIMEOUT_MS,
	);
	if (info.ok) return check("runner", "ok", "docker (isolated checks with a per-run Postgres)");
	return deps.runnerPreference === "docker"
		? check("runner", "fail", `FACTORY_RUNNER=docker but docker info failed: ${info.error.message}`)
		: check(
				"runner",
				"warn",
				`docker unavailable (${info.error.message}); falling back to the host runner, which runs generated code without isolation`,
			);
};

const checkFactoryHome = (deps: DoctorDeps): DoctorCheck => {
	try {
		mkdirSync(deps.factoryHome, { recursive: true });
		accessSync(deps.factoryHome, constants.W_OK);
		return check("factory-home", "ok", `${deps.factoryHome} is writable`);
	} catch (cause) {
		const reason = cause instanceof Error ? cause.message : "unknown error";
		return check("factory-home", "fail", `${deps.factoryHome} is not writable: ${reason}`);
	}
};

const checkMigrations = (deps: DoctorDeps): DoctorCheck => {
	const applied = deps.checkMigrations();
	if (!applied.ok) return check("migrations", "fail", applied.error.message);
	const missing = deps.expectedMigrations.filter((v) => !applied.value.includes(v));
	return missing.length === 0
		? check("migrations", "ok", `applied: ${applied.value.join(", ")}`)
		: check("migrations", "fail", `missing migrations: ${missing.join(", ")}`);
};

export const runDoctor = async (deps: DoctorDeps): Promise<DoctorReport> => {
	const home = checkFactoryHome(deps);
	const migrations =
		home.status === "ok"
			? checkMigrations(deps)
			: check("migrations", "fail", "skipped: FACTORY_HOME is not writable");
	const checks = [
		checkNode(deps),
		await checkGit(deps),
		await checkClaude(deps),
		checkProvider(deps),
		await checkOptional(deps, "docker", "docker", "Docker is needed for isolation from H3"),
		await checkPlaywrightImage(deps),
		await checkRunner(deps),
		home,
		migrations,
	];
	return { checks, hasFailure: checks.some((c) => c.status === "fail") };
};
