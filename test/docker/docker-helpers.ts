import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { NODE_IMAGE, POSTGRES_IMAGE } from "../../src/config/compatibility.js";
import { createDockerRunner } from "../../src/infrastructure/runner/docker-runner.js";
import { containerUserFor } from "../../src/infrastructure/runner/select-runner.js";
import { createSequentialIds } from "../helpers/env.js";

export const dockerAvailable = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

export const SKIP_REASON =
	"docker info failed: Docker daemon not available, real-Docker tests skipped";

if (!dockerAvailable) console.warn(`SKIPPED: ${SKIP_REASON}`);

const SCRATCH_ROOT = join(homedir(), ".cache", "gsf-docker-tests");
const scratchDirs: string[] = [];

export const makeHomeTempDir = (): string => {
	mkdirSync(SCRATCH_ROOT, { recursive: true });
	const dir = mkdtempSync(join(SCRATCH_ROOT, "t-"));
	scratchDirs.push(dir);
	return dir;
};

afterAll(() => {
	for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export const baseEnv = (): Record<string, string> => {
	const env: Record<string, string> = {};
	for (const name of ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT"]) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	return env;
};

export const docker = (...args: string[]): string =>
	execFileSync("docker", args, { encoding: "utf8" }).trim();

export const allContainerNames = (): string[] =>
	docker("ps", "-a", "--format", "{{.Names}}")
		.split("\n")
		.filter((name) => name !== "")
		.sort();

export const labeled = (kind: "ps" | "network", runId: string): string[] => {
	const args =
		kind === "ps"
			? ["ps", "-a", "--filter", `label=factory.run=${runId}`, "--format", "{{.Names}}"]
			: ["network", "ls", "--filter", `label=factory.run=${runId}`, "--format", "{{.Name}}"];
	return docker(...args)
		.split("\n")
		.filter((name) => name !== "");
};

const dockerOs = dockerAvailable
	? execFileSync("docker", ["info", "--format", "{{.OperatingSystem}}|{{json .SecurityOptions}}"], {
			encoding: "utf8",
		}).trim()
	: "";

export const hostUser = { uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 };

export const makeDockerRunner = (factoryHome: string, slug = "demo") =>
	createDockerRunner({
		factoryHome,
		dockerBin: "docker",
		baseEnv: baseEnv(),
		nodeImage: NODE_IMAGE,
		postgresImage: POSTGRES_IMAGE,
		user: containerUserFor(dockerOs, hostUser),
		homeDir: homedir(),
		slug,
		ids: createSequentialIds(),
		now: () => Date.now(),
		readyTimeoutMs: 90_000,
	});

export const containerUser = containerUserFor(dockerOs, hostUser);
