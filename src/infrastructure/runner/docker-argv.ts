import { isAbsolute, relative, resolve, sep } from "node:path";
import { isValidRunId } from "../../domain/ids/run-id.js";
import { type Failure, fail, ok, type Result } from "../../shared/result.js";

export type DockerObjectKind = "container" | "network";

const SUFFIX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const DB_IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

export const isValidDbIdent = (value: string): boolean => DB_IDENT.test(value);
const FORBIDDEN_PATH_CHARS = /[,:\n\r\0]/;

const CHECK_MEMORY = "4g";
const CHECK_PIDS = "1024";
const POSTGRES_MEMORY = "1g";
const POSTGRES_PIDS = "256";
const POSTGRES_TMPFS = "/var/lib/postgresql/data:rw,size=512m";
const WORK_DIR = "/work";

type BuildError = Failure<"invalid_input">;

export const networkName = (runId: string): string => `factory-${runId}-net`;
export const postgresContainerName = (runId: string): string => `factory-${runId}-pg`;
export const checkContainerName = (runId: string, suffix: string): string =>
	`factory-${runId}-chk-${suffix}`;

const labelArgs = (runId: string): string[] => [
	"--label",
	"factory.managed=true",
	"--label",
	`factory.run=${runId}`,
];

const isInside = (child: string, parent: string): boolean => {
	const rel = relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

const invalid = (message: string): Result<never, BuildError> => fail("invalid_input", message);

export const buildNetworkCreateArgv = (runId: string): string[] => [
	"network",
	"create",
	...labelArgs(runId),
	networkName(runId),
];

export const buildPostgresArgv = (input: {
	runId: string;
	image: string;
	dbName: string;
	dbUser: string;
}): { argv: string[]; secretEnvNames: string[] } => ({
	argv: [
		"run",
		"-d",
		"--name",
		postgresContainerName(input.runId),
		...labelArgs(input.runId),
		"--network",
		networkName(input.runId),
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

export const buildCheckArgv = (input: {
	runId: string;
	suffix: string;
	image: string;
	workdir: string;
	homeDir: string;
	user: { uid: number; gid: number };
	command: readonly string[];
	secretEnvNames: readonly string[];
	literalEnv: Readonly<Record<string, string>>;
}): Result<string[], BuildError> => {
	if (!isValidRunId(input.runId)) return invalid(`Invalid run id: ${JSON.stringify(input.runId)}`);
	if (!SUFFIX.test(input.suffix)) return invalid(`Invalid container suffix: ${input.suffix}`);
	if (!isAbsolute(input.workdir) || FORBIDDEN_PATH_CHARS.test(input.workdir)) {
		return invalid(`Unsafe work directory: ${JSON.stringify(input.workdir)}`);
	}
	const workdir = resolve(input.workdir);
	if (workdir.includes("docker.sock")) return invalid("The Docker socket cannot be mounted");
	if (isInside(input.homeDir, workdir)) {
		return invalid("The home directory (or one of its ancestors) cannot be mounted");
	}
	if (input.command.length === 0 || input.command.some((arg) => arg.includes("\0"))) {
		return invalid("The command must be a non-empty argv without NUL bytes");
	}
	const names = [...input.secretEnvNames, ...Object.keys(input.literalEnv)];
	if (names.some((name) => !ENV_NAME.test(name)))
		return invalid("Invalid environment variable name");
	if (Object.values(input.literalEnv).some((value) => /[\0\n\r]/.test(value))) {
		return invalid("Invalid environment variable value");
	}
	const literal = {
		...input.literalEnv,
		npm_config_cache: `${WORK_DIR}/.npm-cache`,
		HOME: "/tmp",
	};
	return ok([
		"run",
		"--rm",
		"--name",
		checkContainerName(input.runId, input.suffix),
		...labelArgs(input.runId),
		"--network",
		networkName(input.runId),
		"--user",
		`${input.user.uid}:${input.user.gid}`,
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges",
		"--memory",
		CHECK_MEMORY,
		"--pids-limit",
		CHECK_PIDS,
		"--mount",
		`type=bind,source=${workdir},target=${WORK_DIR}`,
		"-w",
		WORK_DIR,
		...Object.entries(literal).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
		...input.secretEnvNames.flatMap((name) => ["-e", name]),
		input.image,
		...input.command,
	]);
};

export const buildListArgv = (kind: DockerObjectKind, runId: string): string[] => {
	const filters = [
		"--filter",
		"label=factory.managed=true",
		"--filter",
		`label=factory.run=${runId}`,
	];
	return kind === "container"
		? ["ps", "-a", ...filters, "--format", "{{.ID}} {{.Names}}"]
		: ["network", "ls", ...filters, "--format", "{{.ID}} {{.Name}}"];
};

export const buildRemoveArgv = (kind: DockerObjectKind, ids: readonly string[]): string[] =>
	kind === "container" ? ["rm", "-f", "-v", ...ids] : ["network", "rm", ...ids];

export const buildKillArgv = (containerName: string): string[] => ["kill", containerName];

export const buildReadyArgv = (
	runId: string,
	dbUser: string,
	dbName: string,
): Result<string[], BuildError> => {
	if (!isValidRunId(runId) || !DB_IDENT.test(dbName) || !DB_IDENT.test(dbUser)) {
		return invalid("Invalid run id or database identifier for pg_isready");
	}
	return ok([
		"exec",
		postgresContainerName(runId),
		"pg_isready",
		"-h",
		"127.0.0.1",
		"-U",
		dbUser,
		"-d",
		dbName,
	]);
};
