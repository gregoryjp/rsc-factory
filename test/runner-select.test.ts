import { describe, expect, it } from "vitest";
import { containerUserFor, selectRunner } from "../src/infrastructure/runner/select-runner.js";
import type { CheckRunnerPort } from "../src/modules/execution/ports.js";
import { err, ok } from "../src/shared/result.js";

const fakeRunner = (kind: "docker" | "host"): CheckRunnerPort => ({
	kind,
	isolated: kind === "docker",
	runCheck: async () => ({ ok: false, error: { code: "runner_failed", message: "unused" } }),
	teardown: async () => ok(undefined),
});

const deps = (
	probe:
		| ReturnType<typeof ok<{ stdout: string }>>
		| ReturnType<typeof err<{ code: "failed"; message: string }>>,
) => {
	const calls: string[][] = [];
	return {
		calls,
		exec: async (bin: string, args: readonly string[]) => {
			calls.push([bin, ...args]);
			return probe;
		},
		makeDocker: (os: string) => ({ ...fakeRunner("docker"), note: os }) as CheckRunnerPort,
		makeHost: () => fakeRunner("host"),
	};
};

describe("containerUserFor", () => {
	it("uses the host uid:gid on a native engine", () => {
		expect(containerUserFor("Ubuntu 24.04.3 LTS", { uid: 1000, gid: 1001 })).toEqual({
			uid: 1000,
			gid: 1001,
		});
	});

	it("maps to container root on Docker Desktop, whose VM remaps it to the host user", () => {
		expect(containerUserFor("Docker Desktop", { uid: 1000, gid: 1000 })).toEqual({
			uid: 0,
			gid: 0,
		});
	});

	it.each([
		'Ubuntu 24.04|["name=seccomp,profile=builtin","name=rootless","name=cgroupns"]',
		'Ubuntu 24.04|["name=seccomp,profile=builtin","name=userns"]',
	])("treats rootless and userns-remap engines like Docker Desktop: %s", (info) => {
		expect(containerUserFor(info, { uid: 1000, gid: 1000 })).toEqual({ uid: 0, gid: 0 });
	});

	it("keeps the host user on a plain engine", () => {
		expect(
			containerUserFor('Ubuntu 24.04|["name=seccomp,profile=builtin"]', { uid: 1000, gid: 1000 }),
		).toEqual({ uid: 1000, gid: 1000 });
	});
});

describe("selectRunner", () => {
	it("host preference never probes docker", async () => {
		const d = deps(ok({ stdout: "x" }));
		const selected = await selectRunner({ preference: "host", ...d });
		expect(selected).toMatchObject({ ok: true, value: { runner: { kind: "host" } } });
		expect(d.calls).toEqual([]);
	});

	it("auto picks docker when docker info succeeds", async () => {
		const selected = await selectRunner({
			preference: "auto",
			...deps(ok({ stdout: "Ubuntu\n" })),
		});
		expect(selected).toMatchObject({ ok: true, value: { runner: { kind: "docker" } } });
	});

	it("auto falls back to the host runner with an explicit warning when docker is unavailable", async () => {
		const selected = await selectRunner({
			preference: "auto",
			...deps(err({ code: "failed", message: "daemon down" })),
		});
		expect(selected).toMatchObject({ ok: true, value: { runner: { kind: "host" } } });
		if (selected.ok) expect(selected.value.warning).toMatch(/without isolation/i);
	});

	it("an explicit docker preference never falls back to the host", async () => {
		const selected = await selectRunner({
			preference: "docker",
			...deps(err({ code: "failed", message: "daemon down" })),
		});
		expect(selected).toMatchObject({ ok: false, error: { code: "runner_unavailable" } });
	});

	it("probes with docker info only", async () => {
		const d = deps(ok({ stdout: "Docker Desktop\n" }));
		await selectRunner({ preference: "auto", ...d });
		expect(d.calls).toEqual([
			["docker", "info", "--format", "{{.OperatingSystem}}|{{json .SecurityOptions}}"],
		]);
	});

	it("host runner selections warn about the missing isolation", async () => {
		const selected = await selectRunner({ preference: "host", ...deps(ok({ stdout: "" })) });
		if (selected.ok) expect(selected.value.warning).toMatch(/without isolation/i);
	});
});
