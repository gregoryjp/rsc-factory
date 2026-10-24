import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { NODE_IMAGE, PLAYWRIGHT_IMAGE, POSTGRES_IMAGE } from "../src/config/compatibility.js";
import {
	buildPlaywrightArgv,
	buildPreviewListArgv,
	buildPreviewNetworkArgv,
	buildPreviewPostgresArgv,
	buildPreviewServiceArgv,
	buildPreviewStepArgv,
	previewContainerName,
	previewNetworkName,
} from "../src/infrastructure/runner/docker-preview-argv.js";
import type { Result } from "../src/shared/result.js";

const runId = "run_0f1e2d3c";
const pid = "pv1a2b3c";
const user = { uid: 1000, gid: 1000 };
const home = homedir();

const unwrap = <T>(result: Result<T, { message: string }>): T => {
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
};

const all = (): string[][] => [
	buildPreviewNetworkArgv(runId, pid, "egress"),
	buildPreviewNetworkArgv(runId, pid, "internal"),
	buildPreviewPostgresArgv({ runId, pid, image: POSTGRES_IMAGE, dbName: "demo", dbUser: "factory" })
		.argv,
	unwrap(
		buildPreviewStepArgv({
			runId,
			pid,
			suffix: "s1",
			network: "egress",
			image: NODE_IMAGE,
			workdir: "/tmp/fx/product",
			homeDir: home,
			user,
			command: ["npm", "ci"],
			secretEnvNames: [],
			literalEnv: {},
		}),
	),
	unwrap(
		buildPreviewServiceArgv({
			runId,
			pid,
			role: "web",
			image: NODE_IMAGE,
			homeDir: home,
			user,
			mounts: [
				{ source: "/tmp/fx/product/web/dist", target: "/site", readOnly: true },
				{ source: "/tmp/fx/tools", target: "/tool", readOnly: true },
			],
			command: ["node", "/tool/static-server.mjs", "/site", "4173"],
			secretEnvNames: [],
			literalEnv: {},
		}),
	),
	unwrap(
		buildPlaywrightArgv({
			runId,
			pid,
			image: PLAYWRIGHT_IMAGE,
			toolDir: "/tmp/fx/tools",
			outDir: "/tmp/fx/out",
			homeDir: home,
			user,
			literalEnv: { BASE_URL: "http://x:4173" },
		}),
	),
];

describe("preview docker argv", () => {
	it("labels every created object with managed, run and preview", () => {
		for (const argv of all()) {
			const labels = argv.flatMap((arg, i) => (argv[i - 1] === "--label" ? [arg] : []));
			expect(labels).toEqual([
				"factory.managed=true",
				`factory.run=${runId}`,
				`factory.preview=${pid}`,
			]);
		}
	});

	it("prefixes names with factory-<runId>-<previewId>", () => {
		expect(previewNetworkName(runId, pid, "egress")).toBe(`factory-${runId}-${pid}-net`);
		expect(previewNetworkName(runId, pid, "internal")).toBe(`factory-${runId}-${pid}-int`);
		expect(previewContainerName(runId, pid, "web")).toBe(`factory-${runId}-${pid}-web`);
		for (const argv of all()) {
			const i = argv.indexOf("--name");
			const name = i === -1 ? argv.at(-1) : argv[i + 1];
			expect(name).toMatch(new RegExp(`^factory-${runId}-${pid}-`));
		}
	});

	it("never publishes ports, mounts the docker socket, the home directory or uses the host network", () => {
		for (const argv of all()) {
			expect(argv).not.toContain("-p");
			expect(argv).not.toContain("--publish");
			expect(argv).not.toContain("-P");
			expect(argv.join(" ")).not.toContain("docker.sock");
			expect(argv.join(" ")).not.toContain("--network host");
			expect(argv.join(" ")).not.toContain(`source=${home},`);
			expect(argv).not.toContain("--privileged");
			expect(argv).not.toContain("--ipc");
		}
	});

	it("runs services detached on the preview network with dropped capabilities", () => {
		const service = all()[4] ?? [];
		expect(service[0]).toBe("run");
		expect(service).toContain("-d");
		expect(service[service.indexOf("--network") + 1]).toBe(
			previewNetworkName(runId, pid, "internal"),
		);
		expect(service[service.indexOf("--cap-drop") + 1]).toBe("ALL");
		expect(service).toContain("no-new-privileges");
	});

	it("creates the egress network plain and the runtime network as --internal", () => {
		expect(buildPreviewNetworkArgv(runId, pid, "egress")).not.toContain("--internal");
		expect(buildPreviewNetworkArgv(runId, pid, "internal")).toContain("--internal");
	});

	it("puts install and build steps on the egress network and everything at runtime on the internal one", () => {
		const networkOf = (argv: string[]) => argv[argv.indexOf("--network") + 1];
		const [, , pg, step, web, pw] = all();
		expect(networkOf(step ?? [])).toBe(previewNetworkName(runId, pid, "egress"));
		for (const argv of [pg, web, pw]) {
			expect(networkOf(argv ?? [])).toBe(previewNetworkName(runId, pid, "internal"));
		}
		const internalStep = unwrap(
			buildPreviewStepArgv({
				runId,
				pid,
				suffix: "migrate",
				network: "internal",
				image: NODE_IMAGE,
				workdir: "/tmp/fx/product",
				homeDir: home,
				user,
				command: ["npm", "run", "db:deploy"],
				secretEnvNames: ["DATABASE_URL"],
				literalEnv: {},
			}),
		);
		expect(networkOf(internalStep)).toBe(previewNetworkName(runId, pid, "internal"));
	});

	it("mounts the engine tools and the output as the only playwright mounts, tools read-only", () => {
		const pw = all()[5] ?? [];
		const mounts = pw.flatMap((arg, i) => (pw[i - 1] === "--mount" ? [arg] : []));
		expect(mounts).toEqual([
			"type=bind,source=/tmp/fx/tools,target=/tool,readonly",
			"type=bind,source=/tmp/fx/out,target=/out",
		]);
		expect(pw).toContain(PLAYWRIGHT_IMAGE);
		expect(pw.slice(-2)).toEqual(["node", "/tool/capture.mjs"]);
	});

	it("keeps the product snapshot read-only when serving it", () => {
		const service = all()[4] ?? [];
		expect(service).toContain("type=bind,source=/tmp/fx/product/web/dist,target=/site,readonly");
	});

	it("rejects unsafe mounts", () => {
		const base = {
			runId,
			pid,
			suffix: "s1",
			network: "egress" as const,
			image: NODE_IMAGE,
			homeDir: home,
			user,
			command: ["npm", "ci"],
			secretEnvNames: [],
			literalEnv: {},
		};
		for (const workdir of [
			home,
			"/",
			"relative/dir",
			"/tmp/a,b",
			"/var/run/docker.sock",
			"/x/docker.sock/y",
		]) {
			const built = buildPreviewStepArgv({ ...base, workdir });
			expect(built.ok, workdir).toBe(false);
		}
		expect(buildPreviewStepArgv({ ...base, workdir: "/tmp/ok", suffix: "../x" }).ok).toBe(false);
		expect(buildPreviewStepArgv({ ...base, workdir: "/tmp/ok", runId: "bad id" }).ok).toBe(false);
	});

	it("lists only objects of this preview by label", () => {
		expect(buildPreviewListArgv("container", runId, pid)).toEqual([
			"ps",
			"-a",
			"--filter",
			"label=factory.managed=true",
			"--filter",
			`label=factory.run=${runId}`,
			"--filter",
			`label=factory.preview=${pid}`,
			"--format",
			"{{.ID}} {{.Names}}",
		]);
		expect(buildPreviewListArgv("network", runId, pid).slice(0, 2)).toEqual(["network", "ls"]);
	});
});
