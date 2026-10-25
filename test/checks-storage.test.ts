import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Check } from "../src/contracts/entities.js";
import { startRun } from "../src/modules/runs/start-run.js";
import { createEnv, makeTempDir, writePrd } from "./helpers/env.js";

const seedRun = () => {
	const env = createEnv();
	const dir = makeTempDir();
	const started = startRun(env, {
		prdPath: writePrd(dir),
		targetPath: join(makeTempDir(), "product"),
		projectName: "checks-demo",
		cwd: dir,
		forceNew: false,
		deliveryTarget: null,
	});
	if (!started.ok) throw new Error(started.error.message);
	return { env, runId: started.value.run.id };
};

const sample = (runId: string, overrides: Partial<Check> = {}): Check => ({
	id: "chk_1",
	runId,
	taskId: null,
	argv: ["npm", "run", "check"],
	cwd: "product",
	exitCode: 3,
	durationMs: 1234,
	commitSha: "a".repeat(40),
	logPath: `runs/${runId}/checks/chk_1.log`,
	logSha256: "b".repeat(64),
	isolated: true,
	createdAt: 1_700_000_000_000,
	...overrides,
});

describe("checks table (migration 4)", () => {
	it("is applied after the planning migrations", () => {
		expect(seedRun().env.storage.appliedMigrations()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
	});

	it("round-trips a check, including argv and the isolated flag", () => {
		const { env, runId } = seedRun();
		env.storage.checks.insert(sample(runId));
		env.storage.checks.insert(sample(runId, { id: "chk_2", isolated: false, exitCode: 0 }));
		expect(env.storage.checks.get("chk_1")).toEqual(sample(runId));
		expect(env.storage.checks.get("chk_2")).toMatchObject({ isolated: false, exitCode: 0 });
		expect(env.storage.checks.listByRun(runId).map((c) => c.id)).toEqual(["chk_1", "chk_2"]);
		expect(env.storage.checks.get("missing")).toBeUndefined();
	});

	it("stores a null commit-independent task id", () => {
		const { env, runId } = seedRun();
		env.storage.checks.insert(sample(runId));
		expect(env.storage.checks.get("chk_1")?.taskId).toBeNull();
	});

	it("rejects a check for an unknown run", () => {
		const { env } = seedRun();
		expect(() => env.storage.checks.insert(sample("run_missing"))).toThrow();
	});
});
