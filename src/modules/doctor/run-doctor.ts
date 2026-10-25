import { accessSync, constants, mkdirSync } from "node:fs";
import { MIN_NODE_MAJOR, PLAYWRIGHT_IMAGE } from "../../config/compatibility.js";
import type { ProviderConfig, RunnerPreference } from "../../config/env.js";
import type { RolesConfig } from "../../contracts/planning.js";
import { independenceWarnings } from "../../domain/planning/roles.js";
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
	expectedCodexVersion: string;
	codexBin?: string;
	codexHostUnsafe?: boolean;
	roles: Result<RolesConfig, Failure<string>>;
	codexModels: Result<string[], Failure<string>>;
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

const codexRoles = (deps: DoctorDeps): [string, string][] =>
	deps.roles.ok
		? Object.entries(deps.roles.value).flatMap(([role, config]) =>
				config.provider === "codex" ? [[role, config.model] as [string, string]] : [],
			)
		: [];

const checkCodex = async (deps: DoctorDeps): Promise<DoctorCheck> => {
	if (codexRoles(deps).length === 0) return check("codex", "ok", "not used by any role");
	const found = await probe(deps, deps.codexBin ?? "codex", ["--version"]);
	if (!found.found) {
		return check("codex", "warn", `${found.reason}; roles configured for codex will fail`);
	}
	return found.version === deps.expectedCodexVersion
		? check("codex", "ok", `Codex CLI ${found.version}`)
		: check(
				"codex",
				"warn",
				`Codex CLI ${found.version}; compatibility matrix verified ${deps.expectedCodexVersion}`,
			);
};

const checkCodexIsolation = async (deps: DoctorDeps): Promise<DoctorCheck> => {
	if (codexRoles(deps).length === 0) return check("codex-isolation", "ok", "not used by any role");
	const info = await deps.exec(
		"docker",
		["info", "--format", "{{.OperatingSystem}}"],
		PROBE_TIMEOUT_MS,
	);
	if (info.ok) {
		return check("codex-isolation", "ok", "codex runs in a read-only container (ADR 0018)");
	}
	return deps.codexHostUnsafe === true
		? check(
				"codex-isolation",
				"warn",
				`docker unavailable (${info.error.message}); FACTORY_CODEX_HOST_UNSAFE=1 runs codex on the host, where it can read the whole filesystem`,
			)
		: check(
				"codex-isolation",
				"fail",
				`codex_requires_docker: docker unavailable (${info.error.message}); start Docker or set FACTORY_CODEX_HOST_UNSAFE=1`,
			);
};

const checkCodexModels = (deps: DoctorDeps): DoctorCheck => {
	const used = codexRoles(deps);
	if (used.length === 0) return check("codex-models", "ok", "not used by any role");
	if (!deps.codexModels.ok) {
		return check(
			"codex-models",
			"warn",
			`could not verify codex models: ${deps.codexModels.error.message}`,
		);
	}
	const known = deps.codexModels.value;
	const missing = [...new Set(used.map(([, model]) => model))].filter((m) => !known.includes(m));
	return missing.length === 0
		? check("codex-models", "ok", "configured codex models are in models_cache.json")
		: check("codex-models", "warn", `not in models_cache.json: ${missing.join(", ")}`);
};

const checkRoleIndependence = (deps: DoctorDeps): DoctorCheck => {
	if (!deps.roles.ok) {
		return check(
			"role-independence",
			"warn",
			`roles config unavailable: ${deps.roles.error.message}`,
		);
	}
	const warnings = independenceWarnings(deps.roles.value);
	return warnings.length === 0
		? check("role-independence", "ok", "every reviewer differs from the builder")
		: check("role-independence", "warn", warnings.join("; "));
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
		await checkCodex(deps),
		checkCodexModels(deps),
		await checkCodexIsolation(deps),
		checkRoleIndependence(deps),
		checkProvider(deps),
		await checkOptional(deps, "docker", "docker", "Docker is needed for isolation from H3"),
		await checkPlaywrightImage(deps),
		await checkRunner(deps),
		home,
		migrations,
	];
	return { checks, hasFailure: checks.some((c) => c.status === "fail") };
};
