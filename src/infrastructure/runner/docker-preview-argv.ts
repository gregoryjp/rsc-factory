import { isAbsolute, relative, resolve, sep } from "node:path";
import { isValidRunId } from "../../domain/ids/run-id.js";
import { type Failure, fail, ok, type Result } from "../../shared/result.js";
import type { DockerObjectKind } from "./docker-argv.js";

type BuildError = Failure<"invalid_input">;

const SUFFIX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const PREVIEW_ID = /^pv[0-9a-f]{6}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FORBIDDEN_PATH_CHARS = /[,:\n\r\0]/;
const STEP_MEMORY = "4g";
const STEP_PIDS = "1024";
const SERVICE_MEMORY = "2g";
const SERVICE_PIDS = "512";
const BROWSER_MEMORY = "4g";
const BROWSER_PIDS = "2048";
const BROWSER_SHM = "1g";
const POSTGRES_MEMORY = "1g";
const POSTGRES_PIDS = "256";
const POSTGRES_TMPFS = "/var/lib/postgresql/data:rw,size=512m";
const WORK_DIR = "/work";
const TOOL_DIR = "/tool";
const OUT_DIR = "/out";

export type PreviewMount = { source: string; target: string; readOnly: boolean };
export type PreviewRole = "web" | "api" | "pg" | "pw";

const invalid = (message: string): Result<never, BuildError> => fail("invalid_input", message);

const isInside = (child: string, parent: string): boolean => {
	const rel = relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

export type PreviewNetworkKind = "egress" | "internal";

const NETWORK_SUFFIX: Record<PreviewNetworkKind, string> = { egress: "net", internal: "int" };

export const previewNetworkName = (runId: string, pid: string, kind: PreviewNetworkKind): string =>
	`factory-${runId}-${pid}-${NETWORK_SUFFIX[kind]}`;

export const previewContainerName = (runId: string, pid: string, role: string): string =>
	`factory-${runId}-${pid}-${role}`;

const labelArgs = (runId: string, pid: string): string[] => [
	"--label",
	"factory.managed=true",
	"--label",
	`factory.run=${runId}`,
	"--label",
	`factory.preview=${pid}`,
];

const checkIdentity = (runId: string, pid: string): BuildError | undefined => {
	if (!isValidRunId(runId)) return { code: "invalid_input", message: `Invalid run id: ${runId}` };
	if (!PREVIEW_ID.test(pid))
		return { code: "invalid_input", message: `Invalid preview id: ${pid}` };
	return undefined;
};

const checkMount = (mount: PreviewMount, homeDir: string): BuildError | undefined => {
	if (!isAbsolute(mount.source) || FORBIDDEN_PATH_CHARS.test(mount.source)) {
		return {
			code: "invalid_input",
			message: `Unsafe mount source: ${JSON.stringify(mount.source)}`,
		};
	}
	const source = resolve(mount.source);
	if (source.includes("docker.sock")) {
		return { code: "invalid_input", message: "The Docker socket cannot be mounted" };
	}
	if (source === sep || isInside(homeDir, source)) {
		return {
			code: "invalid_input",
			message: "The home directory (or one of its ancestors) cannot be mounted",
		};
	}
	return undefined;
};

const checkEnv = (
	secretEnvNames: readonly string[],
	literalEnv: Readonly<Record<string, string>>,
): BuildError | undefined => {
	const names = [...secretEnvNames, ...Object.keys(literalEnv)];
	if (names.some((name) => !ENV_NAME.test(name))) {
		return { code: "invalid_input", message: "Invalid environment variable name" };
	}
	if (Object.values(literalEnv).some((value) => /[\0\n\r]/.test(value))) {
		return { code: "invalid_input", message: "Invalid environment variable value" };
	}
	return undefined;
};

const checkCommand = (command: readonly string[]): BuildError | undefined =>
	command.length === 0 || command.some((arg) => arg.includes("\0"))
		? { code: "invalid_input", message: "The command must be a non-empty argv without NUL bytes" }
		: undefined;

const mountArgs = (mounts: readonly PreviewMount[]): string[] =>
	mounts.flatMap((mount) => [
		"--mount",
		`type=bind,source=${resolve(mount.source)},target=${mount.target}${mount.readOnly ? ",readonly" : ""}`,
	]);

const envArgs = (
	literalEnv: Readonly<Record<string, string>>,
	secretEnvNames: readonly string[],
): string[] => [
	...Object.entries(literalEnv).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
	...secretEnvNames.flatMap((name) => ["-e", name]),
];

const hardening = (user: { uid: number; gid: number }, memory: string, pids: string): string[] => [
	"--user",
	`${user.uid}:${user.gid}`,
	"--cap-drop",
	"ALL",
	"--security-opt",
	"no-new-privileges",
	"--memory",
	memory,
	"--pids-limit",
	pids,
];

export const buildPreviewNetworkArgv = (
	runId: string,
	pid: string,
	kind: PreviewNetworkKind,
): string[] => [
	"network",
	"create",
	...(kind === "internal" ? ["--internal"] : []),
	...labelArgs(runId, pid),
	previewNetworkName(runId, pid, kind),
];

export const buildPreviewPostgresArgv = (input: {
	runId: string;
	pid: string;
	image: string;
	dbName: string;
	dbUser: string;
}): { argv: string[]; secretEnvNames: string[] } => ({
	argv: [
		"run",
		"-d",
		"--name",
		previewContainerName(input.runId, input.pid, "pg"),
		...labelArgs(input.runId, input.pid),
		"--network",
		previewNetworkName(input.runId, input.pid, "internal"),
		"--security-opt",
		"no-new-privileges",
		"--memory",
		POSTGRES_MEMORY,
		"--pids-limit",
		POSTGRES_PIDS,
		"--tmpfs",
		POSTGRES_TMPFS,
		"-e",
		`POSTGRES_USER=${input.dbUser}`,
		"-e",
		`POSTGRES_DB=${input.dbName}`,
		"-e",
		"POSTGRES_PASSWORD",
		input.image,
		"-c",
		"fsync=off",
	],
	secretEnvNames: ["POSTGRES_PASSWORD"],
});

export const buildPreviewStepArgv = (input: {
	runId: string;
	pid: string;
	suffix: string;
	network: PreviewNetworkKind;
	image: string;
	workdir: string;
	homeDir: string;
	user: { uid: number; gid: number };
	command: readonly string[];
	secretEnvNames: readonly string[];
	literalEnv: Readonly<Record<string, string>>;
}): Result<string[], BuildError> => {
	const problem =
		checkIdentity(input.runId, input.pid) ??
		(SUFFIX.test(input.suffix)
			? undefined
			: ({
					code: "invalid_input",
					message: `Invalid container suffix: ${input.suffix}`,
				} as const)) ??
		checkMount({ source: input.workdir, target: WORK_DIR, readOnly: false }, input.homeDir) ??
		checkCommand(input.command) ??
		checkEnv(input.secretEnvNames, input.literalEnv);
	if (problem) return invalid(problem.message);
	const literal = { ...input.literalEnv, npm_config_cache: `${WORK_DIR}/.npm-cache`, HOME: "/tmp" };
	return ok([
		"run",
		"--rm",
		"--name",
		previewContainerName(input.runId, input.pid, `step-${input.suffix}`),
		...labelArgs(input.runId, input.pid),
		"--network",
		previewNetworkName(input.runId, input.pid, input.network),
		...hardening(input.user, STEP_MEMORY, STEP_PIDS),
		...mountArgs([{ source: input.workdir, target: WORK_DIR, readOnly: false }]),
		"-w",
		WORK_DIR,
		...envArgs(literal, input.secretEnvNames),
		input.image,
		...input.command,
	]);
};

export const buildPreviewServiceArgv = (input: {
	runId: string;
	pid: string;
	role: "web" | "api";
	image: string;
	homeDir: string;
	user: { uid: number; gid: number };
	mounts: readonly PreviewMount[];
	workdir?: string;
	command: readonly string[];
	secretEnvNames: readonly string[];
	literalEnv: Readonly<Record<string, string>>;
}): Result<string[], BuildError> => {
	const mountProblem = input.mounts
		.map((mount) => checkMount(mount, input.homeDir))
		.find((problem) => problem !== undefined);
	const problem =
		checkIdentity(input.runId, input.pid) ??
		mountProblem ??
		checkCommand(input.command) ??
		checkEnv(input.secretEnvNames, input.literalEnv);
	if (problem) return invalid(problem.message);
	return ok([
		"run",
		"-d",
		"--name",
		previewContainerName(input.runId, input.pid, input.role),
		...labelArgs(input.runId, input.pid),
		"--network",
		previewNetworkName(input.runId, input.pid, "internal"),
		...hardening(input.user, SERVICE_MEMORY, SERVICE_PIDS),
		...mountArgs(input.mounts),
		"-w",
		input.workdir ?? TOOL_DIR,
		...envArgs({ ...input.literalEnv, HOME: "/tmp" }, input.secretEnvNames),
		input.image,
		...input.command,
	]);
};

export const buildPlaywrightArgv = (input: {
	runId: string;
	pid: string;
	image: string;
	toolDir: string;
	outDir: string;
	homeDir: string;
	user: { uid: number; gid: number };
	literalEnv: Readonly<Record<string, string>>;
	secretEnvNames?: readonly string[];
}): Result<string[], BuildError> => {
	const secretNames = input.secretEnvNames ?? [];
	const mounts: PreviewMount[] = [
		{ source: input.toolDir, target: TOOL_DIR, readOnly: true },
		{ source: input.outDir, target: OUT_DIR, readOnly: false },
	];
	const mountProblem = mounts
		.map((mount) => checkMount(mount, input.homeDir))
		.find((problem) => problem !== undefined);
	const problem =
		checkIdentity(input.runId, input.pid) ??
		mountProblem ??
		checkEnv(secretNames, input.literalEnv);
	if (problem) return invalid(problem.message);
	return ok([
		"run",
		"--rm",
		"--name",
		previewContainerName(input.runId, input.pid, "pw"),
		...labelArgs(input.runId, input.pid),
		"--network",
		previewNetworkName(input.runId, input.pid, "internal"),
		...hardening(input.user, BROWSER_MEMORY, BROWSER_PIDS),
		"--shm-size",
		BROWSER_SHM,
		...mountArgs(mounts),
		"-w",
		TOOL_DIR,
		...envArgs({ ...input.literalEnv, HOME: "/tmp", OUT_DIR }, secretNames),
		input.image,
		"node",
		`${TOOL_DIR}/capture.mjs`,
	]);
};

export const buildPreviewListArgv = (
	kind: DockerObjectKind,
	runId: string,
	pid: string,
): string[] => {
	const filters = [
		"--filter",
		"label=factory.managed=true",
		"--filter",
		`label=factory.run=${runId}`,
		"--filter",
		`label=factory.preview=${pid}`,
	];
	return kind === "container"
		? ["ps", "-a", ...filters, "--format", "{{.ID}} {{.Names}}"]
		: ["network", "ls", ...filters, "--format", "{{.ID}} {{.Name}}"];
};

export const PREVIEW_PATHS = { work: WORK_DIR, tool: TOOL_DIR, out: OUT_DIR } as const;
