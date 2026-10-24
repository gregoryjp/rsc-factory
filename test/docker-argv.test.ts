import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { NODE_IMAGE, POSTGRES_IMAGE } from "../src/config/compatibility.js";
import {
	buildCheckArgv,
	buildKillArgv,
	buildListArgv,
	buildNetworkCreateArgv,
	buildPostgresArgv,
	buildReadyArgv,
	buildRemoveArgv,
	checkContainerName,
	postgresContainerName,
} from "../src/infrastructure/runner/docker-argv.js";

const runId = "run_0f1e2d3c";
const workdir = "/tmp/factory-test-abc/worktree";
const user = { uid: 1000, gid: 1000 };
const home = homedir();

const checkArgv = () => {
	const built = buildCheckArgv({
		runId,
		suffix: "a1b2c3d4",
		image: NODE_IMAGE,
		workdir,
		homeDir: home,
		user,
		command: ["npm", "run", "check"],
		secretEnvNames: ["TEST_DATABASE_URL", "DATABASE_URL"],
		literalEnv: { NODE_ENV: "test" },
	});
	if (!built.ok) throw new Error(built.error.message);
	return built.value;
};

const postgresArgv = () =>
	buildPostgresArgv({ runId, image: POSTGRES_IMAGE, dbName: "demo_test", dbUser: "factory" });

const allCreatingArgvs = () => [buildNetworkCreateArgv(runId), postgresArgv().argv, checkArgv()];

describe("docker argv builders", () => {
	it("label every created object with factory.managed and factory.run", () => {
		for (const argv of allCreatingArgvs()) {
			const labels = argv.flatMap((arg, i) => (argv[i - 1] === "--label" ? [arg] : []));
			expect(labels).toEqual(["factory.managed=true", `factory.run=${runId}`]);
		}
	});

	it("prefix every created object name with factory-<runId>", () => {
		const names = allCreatingArgvs().map((argv) => {
			const i = argv.indexOf("--name");
			return i === -1 ? argv[argv.length - 1] : argv[i + 1];
		});
		for (const name of names) expect(name).toMatch(new RegExp(`^factory-${runId}-`));
		expect(postgresContainerName(runId)).toBe(`factory-${runId}-pg`);
		expect(checkContainerName(runId, "a1b2c3d4")).toBe(`factory-${runId}-chk-a1b2c3d4`);
	});

	it("never publishes ports, mounts the docker socket or mounts the home directory", () => {
		for (const argv of allCreatingArgvs()) {
			for (const arg of argv) {
				expect(arg).not.toBe("-p");
				expect(arg).not.toBe("-P");
				expect(arg).not.toMatch(/^--publish/);
				expect(arg).not.toContain("docker.sock");
				expect(arg).not.toBe(home);
			}
			expect(argv).not.toContain("--privileged");
			expect(argv).not.toContain("--pid=host");
			expect(argv).not.toContain("--network=host");
			expect(argv.join(" ")).not.toMatch(/--network[ =]host/);
		}
	});

	it("runs the check container as the given user, on the run network, confined to /work", () => {
		const argv = checkArgv();
		expect(argv.slice(0, 2)).toEqual(["run", "--rm"]);
		expect(argv[argv.indexOf("--user") + 1]).toBe("1000:1000");
		expect(argv[argv.indexOf("--network") + 1]).toBe(`factory-${runId}-net`);
		expect(argv[argv.indexOf("-w") + 1]).toBe("/work");
		expect(argv).toContain("--mount");
		expect(argv[argv.indexOf("--mount") + 1]).toBe(`type=bind,source=${workdir},target=/work`);
		expect(argv[argv.indexOf("--cap-drop") + 1]).toBe("ALL");
		expect(argv).toContain("no-new-privileges");
		expect(argv.indexOf(NODE_IMAGE)).toBeGreaterThan(-1);
		expect(argv.slice(argv.indexOf(NODE_IMAGE) + 1)).toEqual(["npm", "run", "check"]);
		expect(argv.filter((arg) => arg === "--mount")).toHaveLength(1);
		expect(argv).not.toContain("-v");
	});

	it("passes secret env by name only", () => {
		const argv = checkArgv();
		const envArgs = argv.flatMap((arg, i) => (argv[i - 1] === "-e" ? [arg] : []));
		expect(envArgs).toContain("TEST_DATABASE_URL");
		expect(envArgs).toContain("DATABASE_URL");
		expect(envArgs).toContain("NODE_ENV=test");
		expect(envArgs).toContain("npm_config_cache=/work/.npm-cache");
		expect(envArgs).toContain("HOME=/tmp");
		const pg = postgresArgv();
		expect(pg.secretEnvNames).toEqual(["POSTGRES_PASSWORD"]);
		expect(pg.argv).toContain("POSTGRES_PASSWORD");
		expect(pg.argv.some((arg) => arg.startsWith("POSTGRES_PASSWORD="))).toBe(false);
	});

	it("keeps postgres data in a tmpfs so no anonymous volume is created", () => {
		const { argv } = postgresArgv();
		expect(argv[argv.indexOf("--tmpfs") + 1]).toMatch(/^\/var\/lib\/postgresql\/data/);
		expect(argv).toContain("-d");
		expect(argv).toContain(POSTGRES_IMAGE);
	});

	it("rejects unsafe run ids, work directories and commands", () => {
		const base = {
			runId,
			suffix: "a1",
			image: NODE_IMAGE,
			workdir,
			homeDir: home,
			user,
			command: ["true"],
			secretEnvNames: [],
			literalEnv: {},
		};
		const rejected = (override: Partial<Parameters<typeof buildCheckArgv>[0]>) =>
			buildCheckArgv({ ...base, ...override });
		expect(rejected({ runId: "bad id" })).toMatchObject({ ok: false });
		expect(rejected({ runId: "-x" })).toMatchObject({ ok: false });
		expect(rejected({ workdir: "relative/path" })).toMatchObject({ ok: false });
		expect(rejected({ workdir: "/tmp/a,b" })).toMatchObject({ ok: false });
		expect(rejected({ workdir: "/tmp/a:b" })).toMatchObject({ ok: false });
		expect(rejected({ workdir: "/var/run/docker.sock" })).toMatchObject({ ok: false });
		expect(rejected({ workdir: home })).toMatchObject({ ok: false });
		expect(rejected({ workdir: "/" })).toMatchObject({ ok: false });
		expect(rejected({ workdir: "/home" })).toMatchObject({ ok: false });
		expect(rejected({ command: [] })).toMatchObject({ ok: false });
		expect(rejected({ command: ["a\0b"] })).toMatchObject({ ok: false });
		expect(rejected({ secretEnvNames: ["bad name"] })).toMatchObject({ ok: false });
		expect(rejected({ suffix: "../x" })).toMatchObject({ ok: false });
	});

	it("allows a work directory inside the home directory (a subdirectory, not the home itself)", () => {
		const built = buildCheckArgv({
			runId,
			suffix: "a1",
			image: NODE_IMAGE,
			workdir: `${home}/factory-home/runs/${runId}/worktrees/t1`,
			homeDir: home,
			user,
			command: ["true"],
			secretEnvNames: [],
			literalEnv: {},
		});
		expect(built.ok).toBe(true);
	});

	it("selects objects for cleanup only by the run label", () => {
		for (const kind of ["container", "network"] as const) {
			const argv = buildListArgv(kind, runId);
			const filters = argv.flatMap((arg, i) => (argv[i - 1] === "--filter" ? [arg] : []));
			expect(filters).toEqual(["label=factory.managed=true", `label=factory.run=${runId}`]);
			expect(argv.some((arg) => arg.includes("name="))).toBe(false);
		}
		expect(buildListArgv("container", runId)).toContain("-a");
		expect(buildListArgv("container", runId).slice(0, 2)).toEqual(["ps", "-a"]);
		expect(buildListArgv("network", runId).slice(0, 2)).toEqual(["network", "ls"]);
	});

	it("builds remove, kill and readiness commands for a specific object only", () => {
		expect(buildRemoveArgv("container", ["abc", "def"])).toEqual(["rm", "-f", "-v", "abc", "def"]);
		expect(buildRemoveArgv("network", ["n1"])).toEqual(["network", "rm", "n1"]);
		expect(buildKillArgv(checkContainerName(runId, "a1"))).toEqual([
			"kill",
			`factory-${runId}-chk-a1`,
		]);
		expect(buildReadyArgv(runId, "factory", "demo_test")).toEqual({
			ok: true,
			value: [
				"exec",
				`factory-${runId}-pg`,
				"pg_isready",
				"-h",
				"127.0.0.1",
				"-U",
				"factory",
				"-d",
				"demo_test",
			],
		});
		expect(buildReadyArgv(runId, "factory", "bad name")).toMatchObject({ ok: false });
		expect(buildReadyArgv("bad id", "factory", "demo_test")).toMatchObject({ ok: false });
	});
});
