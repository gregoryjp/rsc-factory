import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostRunner } from "../../src/infrastructure/runner/host-runner.js";
import { sha256Of } from "../../src/shared/hash.js";
import { createSequentialIds, makeTempDir } from "../helpers/env.js";
import {
	allContainerNames,
	baseEnv,
	dockerAvailable,
	labeled,
	makeDockerRunner,
	makeHomeTempDir,
	SKIP_REASON,
} from "./docker-helpers.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const job of cleanup.splice(0)) await job();
});

describe("HostRunner (no isolation)", () => {
	const host = (home: string) =>
		createHostRunner({
			factoryHome: home,
			baseEnv: baseEnv(),
			ids: createSequentialIds(),
			now: Date.now,
		});

	it("records the exit code, a log file with matching sha256 and a tail", async () => {
		const home = makeTempDir();
		const cwd = makeTempDir();
		const result = await host(home).runCheck({
			runId: "run_host",
			cwd,
			argv: ["node", "-e", "console.log('hello-host'); process.exit(3)"],
			env: {},
			timeoutMs: 20_000,
		});
		if (!result.ok) throw new Error(result.error.message);
		expect(result.value).toMatchObject({ exitCode: 3, isolated: false, timedOut: false });
		expect(result.value.tail).toContain("hello-host");
		expect(result.value.logPath).toBe(
			join(home, "runs", "run_host", "checks", `${result.value.checkId}.log`),
		);
		expect(sha256Of(readFileSync(result.value.logPath))).toBe(result.value.logSha256);
	});

	it("kills the process group on timeout and reports exit 124", async () => {
		const result = await host(makeTempDir()).runCheck({
			runId: "run_host",
			cwd: makeTempDir(),
			argv: ["node", "-e", "setTimeout(() => {}, 60000)"],
			env: {},
			timeoutMs: 1_000,
		});
		if (!result.ok) throw new Error(result.error.message);
		expect(result.value).toMatchObject({ exitCode: 124, timedOut: true });
		expect(result.value.durationMs).toBeLessThan(15_000);
	});

	it("rejects invalid input without running anything", async () => {
		const runner = host(makeTempDir());
		const base = {
			runId: "run_host",
			cwd: makeTempDir(),
			argv: ["true"],
			env: {},
			timeoutMs: 1000,
		};
		for (const bad of [
			{ ...base, runId: "bad id" },
			{ ...base, cwd: "relative" },
			{ ...base, argv: [] },
			{ ...base, env: { "bad name": "x" } },
			{ ...base, timeoutMs: 0 },
		]) {
			expect(await runner.runCheck(bad)).toMatchObject({
				ok: false,
				error: { code: "invalid_input" },
			});
		}
	});

	it("reports a missing executable as runner_unavailable", async () => {
		const result = await host(makeTempDir()).runCheck({
			runId: "run_host",
			cwd: makeTempDir(),
			argv: ["definitely-not-a-real-binary-xyz"],
			env: {},
			timeoutMs: 5_000,
		});
		expect(result).toMatchObject({ ok: false, error: { code: "runner_unavailable" } });
	});
});

describe.skipIf(!dockerAvailable)(
	`DockerRunner (${dockerAvailable ? "real Docker" : SKIP_REASON})`,
	() => {
		const runId = `run_t${Date.now().toString(36)}`;

		it("runs a check in a labeled container as the host user with the test database wired in", async () => {
			const home = makeHomeTempDir();
			const cwd = makeHomeTempDir();
			const runner = makeDockerRunner(home);
			cleanup.push(() => runner.teardown(runId));
			const probe = `
			const net = require("node:net");
			const url = new URL(process.env.TEST_DATABASE_URL);
			const sock = net.connect(Number(url.port), url.hostname, () => {
				console.log("env=" + process.env.NODE_ENV + " db=" + url.pathname + " uid=" + process.getuid());
				require("node:fs").writeFileSync("/work/from-container.txt", "x");
				sock.end();
				process.exit(3);
			});
			sock.on("error", (e) => { console.log("connect-failed " + e.message); process.exit(9); });
		`;
			const result = await runner.runCheck({
				runId,
				cwd,
				argv: ["node", "-e", probe],
				env: {},
				timeoutMs: 120_000,
			});
			if (!result.ok) throw new Error(result.error.message);
			expect(result.value).toMatchObject({ exitCode: 3, isolated: true, timedOut: false });
			expect(result.value.tail).toContain("env=test db=/demo_test");
			expect(statSync(join(cwd, "from-container.txt")).uid).toBe(process.getuid?.());
			expect(sha256Of(readFileSync(result.value.logPath))).toBe(result.value.logSha256);
			expect(labeled("ps", runId)).toEqual([`factory-${runId}-pg`]);
			expect(labeled("network", runId)).toEqual([`factory-${runId}-net`]);
		});

		it("does not expose the host home directory or the docker socket to the check", async () => {
			const runner = makeDockerRunner(makeHomeTempDir());
			cleanup.push(() => runner.teardown(runId));
			const probe = `
			const fs = require("node:fs");
			console.log("sock=" + fs.existsSync("/var/run/docker.sock") + " home=" + fs.existsSync(${JSON.stringify(process.env.HOME ?? "/nonexistent")}));
		`;
			const result = await runner.runCheck({
				runId,
				cwd: makeHomeTempDir(),
				argv: ["node", "-e", probe],
				env: {},
				timeoutMs: 120_000,
			});
			if (!result.ok) throw new Error(result.error.message);
			expect(result.value.tail).toContain("sock=false home=false");
		});

		it("kills only the timed-out check container", async () => {
			const runner = makeDockerRunner(makeHomeTempDir());
			cleanup.push(() => runner.teardown(runId));
			const result = await runner.runCheck({
				runId,
				cwd: makeHomeTempDir(),
				argv: ["node", "-e", "setTimeout(() => {}, 120000)"],
				env: {},
				timeoutMs: 8_000,
			});
			if (!result.ok) throw new Error(result.error.message);
			expect(result.value).toMatchObject({ exitCode: 124, timedOut: true });
			expect(labeled("ps", runId)).toEqual([`factory-${runId}-pg`]);
			expect(existsSync(result.value.logPath)).toBe(true);
		});

		it("teardown removes only labeled objects and leaves every pre-existing container alone", async () => {
			const before = allContainerNames();
			const runner = makeDockerRunner(makeHomeTempDir());
			const ran = await runner.runCheck({
				runId,
				cwd: makeHomeTempDir(),
				argv: ["node", "-e", "process.exit(0)"],
				env: {},
				timeoutMs: 120_000,
			});
			expect(ran.ok).toBe(true);
			expect(labeled("ps", runId).length).toBeGreaterThan(0);
			const torn = await runner.teardown(runId);
			expect(torn.ok).toBe(true);
			expect(labeled("ps", runId)).toEqual([]);
			expect(labeled("network", runId)).toEqual([]);
			const after = allContainerNames();
			for (const name of before) expect(after).toContain(name);
			expect(after.filter((name) => name.startsWith(`factory-${runId}`))).toEqual([]);
		});

		it("rejects an invalid run id in teardown without touching docker", async () => {
			const runner = makeDockerRunner(makeHomeTempDir());
			expect(await runner.teardown("../x")).toMatchObject({
				ok: false,
				error: { code: "invalid_input" },
			});
		});
	},
);
