import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { CODEX_IMAGE, NODE_IMAGE } from "../src/config/compatibility.js";
import {
	buildCodexNetworkCreateArgv,
	buildCodexRunArgv,
	CONTAINER_CA_FILE,
	CONTAINER_ENTRYPOINT,
	CONTAINER_LAUNCH_SCRIPT,
	codexContainerName,
	codexNetworkName,
	resolveCodexVendorDir,
} from "../src/infrastructure/providers/codex-docker.js";

const runId = "run_0f1e2d3c";
const hostHome = homedir();
const codexHome = `${hostHome}/.codex`;

const base = {
	runId,
	callId: "a1b2c3",
	image: CODEX_IMAGE,
	vendorDir: `${hostHome}/.nvm/lib/codex/vendor/x86_64-unknown-linux-musl`,
	homeDir: `${hostHome}/.factory/codex-calls/call-a1b2c3/home`,
	schemaFile: `${hostHome}/.factory/codex-calls/call-a1b2c3/schema.json`,
	workspace: `${hostHome}/.factory/work/task-1`,
	writableWorkspace: false,
	user: { uid: 1000, gid: 1000 },
	hostHome,
	forbiddenRoots: [`${hostHome}/.ssh`, codexHome],
	env: { LANG: "C.UTF-8" },
	codexArgs: ["exec", "--json"],
};

const built = (overrides: Partial<typeof base> = {}) => {
	const result = buildCodexRunArgv({ ...base, ...overrides });
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
};

const pairs = (argv: readonly string[], flag: string): string[] =>
	argv.flatMap((arg, index) => (arg === flag ? [argv[index + 1] ?? ""] : []));

describe("codex docker argv", () => {
	it("pins the image by digest and reuses the node image", () => {
		expect(CODEX_IMAGE).toBe(NODE_IMAGE);
		expect(built()).toContain(CODEX_IMAGE);
		expect(CODEX_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
	});

	it("names objects with the factory prefix and labels them", () => {
		const argv = built();
		expect(pairs(argv, "--name")).toEqual([codexContainerName(runId, "a1b2c3")]);
		expect(codexContainerName(runId, "a1b2c3")).toBe("factory-run_0f1e2d3c-codex-a1b2c3");
		expect(codexNetworkName(runId, "a1b2c3")).toBe("factory-run_0f1e2d3c-codex-a1b2c3-net");
		expect(pairs(argv, "--label")).toEqual(["factory.managed=true", `factory.run=${runId}`]);
		expect(pairs(argv, "--network")).toEqual([codexNetworkName(runId, "a1b2c3")]);
		expect(buildCodexNetworkCreateArgv(runId, "a1b2c3")).toEqual([
			"network",
			"create",
			"--label",
			"factory.managed=true",
			"--label",
			`factory.run=${runId}`,
			codexNetworkName(runId, "a1b2c3"),
		]);
		expect(buildCodexNetworkCreateArgv(runId, "a1b2c3")).not.toContain("--internal");
	});

	it("applies every hardening flag", () => {
		const argv = built();
		expect(argv).toContain("--read-only");
		expect(argv).toContain("--rm");
		expect(argv).toContain("-i");
		expect(pairs(argv, "--cap-drop")).toEqual(["ALL"]);
		expect(pairs(argv, "--security-opt")).toEqual(["no-new-privileges"]);
		expect(pairs(argv, "--user")).toEqual(["1000:1000"]);
		expect(pairs(argv, "--memory")).toEqual(["2g"]);
		expect(pairs(argv, "--pids-limit")).toEqual(["512"]);
		expect(pairs(argv, "--tmpfs")).toEqual(["/tmp:rw,nosuid,size=64m"]);
		expect(pairs(argv, "--entrypoint")).toEqual([CONTAINER_ENTRYPOINT]);
		expect(argv).not.toContain("--privileged");
		expect(argv).not.toContain("-p");
		expect(argv).not.toContain("--publish");
		expect(argv).not.toContain("-t");
		expect(argv.join(" ")).not.toContain("--volume");
	});

	it("mounts only the codex package, the call home, the schema and the workspace", () => {
		const mounts = pairs(built(), "--mount");
		expect(mounts).toEqual([
			`type=bind,source=${base.vendorDir},target=/opt/codex,readonly`,
			`type=bind,source=${base.homeDir},target=/codex-home`,
			`type=bind,source=${base.schemaFile},target=/input/schema.json,readonly`,
			`type=bind,source=${base.workspace},target=/workspace,readonly`,
		]);
	});

	it("mounts the workspace writable only when requested", () => {
		const mounts = pairs(built({ writableWorkspace: true }), "--mount");
		expect(mounts.at(-1)).toBe(`type=bind,source=${base.workspace},target=/workspace`);
	});

	it("never mounts HOME, the docker socket, .ssh or the real codex home", () => {
		const forbidden = [
			hostHome,
			"/home",
			`${hostHome}/.ssh`,
			`${hostHome}/.ssh/keys`,
			codexHome,
			`${codexHome}/auth.json`,
			"/var/run/docker.sock",
		];
		for (const workspace of forbidden) {
			expect(buildCodexRunArgv({ ...base, workspace }).ok).toBe(false);
		}
		expect(buildCodexRunArgv({ ...base, homeDir: codexHome }).ok).toBe(false);
		expect(buildCodexRunArgv({ ...base, vendorDir: hostHome }).ok).toBe(false);
		for (const mount of pairs(built(), "--mount")) {
			expect(mount).not.toContain("docker.sock");
			expect(mount).not.toContain(".ssh");
			expect(mount).not.toContain(`source=${hostHome},`);
		}
	});

	it("rejects unsafe paths, ids and env values", () => {
		expect(buildCodexRunArgv({ ...base, workspace: "relative/dir" }).ok).toBe(false);
		expect(buildCodexRunArgv({ ...base, workspace: `${hostHome}/a,b` }).ok).toBe(false);
		expect(buildCodexRunArgv({ ...base, workspace: `${hostHome}/a:b` }).ok).toBe(false);
		expect(buildCodexRunArgv({ ...base, runId: "bad run" }).ok).toBe(false);
		expect(buildCodexRunArgv({ ...base, callId: "x y" }).ok).toBe(false);
		expect(buildCodexRunArgv({ ...base, env: { "BAD NAME": "x" } }).ok).toBe(false);
		expect(buildCodexRunArgv({ ...base, env: { LANG: "a\nb" } }).ok).toBe(false);
	});

	it("passes a minimal environment and the codex arguments after the image", () => {
		const argv = built();
		expect(pairs(argv, "-e").sort()).toEqual(
			[
				`CODEX_CA_CERTIFICATE=${CONTAINER_CA_FILE}`,
				"CODEX_HOME=/codex-home",
				"HOME=/codex-home",
				"LANG=C.UTF-8",
				"PATH=/opt/codex/codex-path:/usr/local/bin:/usr/bin:/bin",
				`SSL_CERT_FILE=${CONTAINER_CA_FILE}`,
				"TMPDIR=/tmp",
			].sort(),
		);
		expect(argv.slice(argv.indexOf(CODEX_IMAGE) + 1)).toEqual([
			"-c",
			CONTAINER_LAUNCH_SCRIPT,
			"codex",
			"exec",
			"--json",
		]);
		expect(pairs(argv, "-w")).toEqual(["/workspace"]);
	});
});

describe("resolveCodexVendorDir", () => {
	it("derives the vendor directory from the platform and architecture", () => {
		const found = resolveCodexVendorDir({
			packageRoot: "/pkg/codex",
			platform: "linux",
			arch: "x64",
			exists: (path) =>
				path === "/pkg/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl",
		});
		expect(found).toEqual({
			ok: true,
			value: "/pkg/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl",
		});
	});

	it("fails for unsupported platforms and missing packages", () => {
		const unsupported = resolveCodexVendorDir({
			packageRoot: "/pkg/codex",
			platform: "darwin",
			arch: "arm64",
			exists: () => true,
		});
		expect(unsupported.ok).toBe(false);
		const missing = resolveCodexVendorDir({
			packageRoot: "/pkg/codex",
			platform: "linux",
			arch: "x64",
			exists: () => false,
		});
		expect(missing.ok).toBe(false);
	});
});
