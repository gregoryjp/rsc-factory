import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { isValidRunId } from "../../domain/ids/run-id.js";
import { type Failure, fail, ok, type Result } from "../../shared/result.js";
import { ENV_NAME, FORBIDDEN_PATH_CHARS, isInside, labelArgs } from "../runner/docker-argv.js";

type BuildError = Failure<"invalid_input">;

const CALL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const MEMORY = "2g";
const PIDS = "512";
const TMPFS = "/tmp:rw,nosuid,size=64m";
const CONTAINER_PATH = "/opt/codex/codex-path:/usr/local/bin:/usr/bin:/bin";

export const CONTAINER_MOUNTS = {
	codex: "/opt/codex",
	home: "/codex-home",
	schema: "/input/schema.json",
	workspace: "/workspace",
} as const;

export const CONTAINER_CODEX_BIN = `${CONTAINER_MOUNTS.codex}/bin/codex`;
export const CONTAINER_CA_FILE = "/tmp/ca-bundle.pem";
export const CONTAINER_ENTRYPOINT = "/bin/sh";
export const CONTAINER_LAUNCH_SCRIPT = `node -e 'process.stdout.write(require("tls").rootCertificates.join("\\n"))' > ${CONTAINER_CA_FILE} && exec ${CONTAINER_CODEX_BIN} "$@"`;

const PACKAGE_BY_TARGET: Record<string, { pkg: string; triple: string }> = {
	"linux-x64": { pkg: "codex-linux-x64", triple: "x86_64-unknown-linux-musl" },
	"linux-arm64": { pkg: "codex-linux-arm64", triple: "aarch64-unknown-linux-musl" },
};

export const codexNetworkName = (runId: string, callId: string): string =>
	`factory-${runId}-codex-${callId}-net`;

export const codexContainerName = (runId: string, callId: string): string =>
	`factory-${runId}-codex-${callId}`;

export const buildCodexNetworkCreateArgv = (runId: string, callId: string): string[] => [
	"network",
	"create",
	...labelArgs(runId),
	codexNetworkName(runId, callId),
];

export const buildCodexCleanupArgvs = (runId: string, callId: string): string[][] => [
	["rm", "-f", "-v", codexContainerName(runId, callId)],
	["network", "rm", codexNetworkName(runId, callId)],
];

const invalid = (message: string): Result<never, BuildError> => fail("invalid_input", message);

const mountArg = (source: string, target: string, readonly: boolean): string =>
	`type=bind,source=${source},target=${target}${readonly ? ",readonly" : ""}`;

export const buildCodexRunArgv = (input: {
	runId: string;
	callId: string;
	image: string;
	vendorDir: string;
	homeDir: string;
	schemaFile: string;
	workspace: string;
	writableWorkspace: boolean;
	user: { uid: number; gid: number };
	hostHome: string;
	forbiddenRoots: readonly string[];
	env: Readonly<Record<string, string>>;
	codexArgs: readonly string[];
}): Result<string[], BuildError> => {
	if (!isValidRunId(input.runId)) return invalid(`Invalid run id: ${JSON.stringify(input.runId)}`);
	if (!CALL_ID.test(input.callId)) return invalid(`Invalid call id: ${input.callId}`);
	const sources = [input.vendorDir, input.homeDir, input.schemaFile, input.workspace];
	for (const source of sources) {
		if (!isAbsolute(source) || FORBIDDEN_PATH_CHARS.test(source)) {
			return invalid(`Unsafe mount source: ${JSON.stringify(source)}`);
		}
		const path = resolve(source);
		if (path.includes("docker.sock")) return invalid("The Docker socket cannot be mounted");
		if (isInside(input.hostHome, path)) {
			return invalid("The home directory (or one of its ancestors) cannot be mounted");
		}
		if (input.forbiddenRoots.some((root) => isInside(path, root) || isInside(root, path))) {
			return invalid(`Mount source touches a forbidden location: ${path}`);
		}
	}
	const literal = {
		...input.env,
		HOME: CONTAINER_MOUNTS.home,
		CODEX_HOME: CONTAINER_MOUNTS.home,
		TMPDIR: "/tmp",
		PATH: CONTAINER_PATH,
		SSL_CERT_FILE: CONTAINER_CA_FILE,
		CODEX_CA_CERTIFICATE: CONTAINER_CA_FILE,
	};
	if (Object.keys(literal).some((name) => !ENV_NAME.test(name))) {
		return invalid("Invalid environment variable name");
	}
	if (Object.values(literal).some((value) => /[\0\n\r]/.test(value))) {
		return invalid("Invalid environment variable value");
	}
	return ok([
		"run",
		"--rm",
		"-i",
		"--name",
		codexContainerName(input.runId, input.callId),
		...labelArgs(input.runId),
		"--network",
		codexNetworkName(input.runId, input.callId),
		"--user",
		`${input.user.uid}:${input.user.gid}`,
		"--read-only",
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges",
		"--memory",
		MEMORY,
		"--pids-limit",
		PIDS,
		"--tmpfs",
		TMPFS,
		"--mount",
		mountArg(input.vendorDir, CONTAINER_MOUNTS.codex, true),
		"--mount",
		mountArg(input.homeDir, CONTAINER_MOUNTS.home, false),
		"--mount",
		mountArg(input.schemaFile, CONTAINER_MOUNTS.schema, true),
		"--mount",
		mountArg(input.workspace, CONTAINER_MOUNTS.workspace, !input.writableWorkspace),
		"-w",
		CONTAINER_MOUNTS.workspace,
		...Object.entries(literal).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
		"--entrypoint",
		CONTAINER_ENTRYPOINT,
		input.image,
		"-c",
		CONTAINER_LAUNCH_SCRIPT,
		"codex",
		...input.codexArgs,
	]);
};

export const resolveCodexVendorDir = (input: {
	packageRoot: string;
	platform: string;
	arch: string;
	exists: (path: string) => boolean;
}): Result<string, Failure<"codex_package_not_found">> => {
	const target = PACKAGE_BY_TARGET[`${input.platform}-${input.arch}`];
	if (target === undefined) {
		return fail(
			"codex_package_not_found",
			`Codex container isolation supports linux x64/arm64, not ${input.platform}-${input.arch}`,
		);
	}
	const vendorDir = join(
		input.packageRoot,
		"node_modules",
		"@openai",
		target.pkg,
		"vendor",
		target.triple,
	);
	return input.exists(vendorDir)
		? ok(vendorDir)
		: fail("codex_package_not_found", `Codex native package not found at ${vendorDir}`);
};

export const findCodexVendorDir = (
	binaryPath: string,
	pathEnv: string | undefined,
): Result<string, Failure<"codex_package_not_found">> => {
	const candidates = isAbsolute(binaryPath)
		? [binaryPath]
		: (pathEnv ?? "")
				.split(delimiter)
				.filter((entry) => entry !== "")
				.map((entry) => join(entry, binaryPath));
	const located = candidates.find((candidate) => existsSync(candidate));
	if (located === undefined) {
		return fail("codex_package_not_found", `Codex binary not found: ${binaryPath}`);
	}
	return resolveCodexVendorDir({
		packageRoot: dirname(dirname(realpathSync(located))),
		platform: process.platform,
		arch: process.arch,
		exists: existsSync,
	});
};
