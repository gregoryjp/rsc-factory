import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { Run, Task } from "../src/contracts/entities.js";
import { openStorage } from "../src/infrastructure/storage/sqlite-storage.js";
import { cancelRun } from "../src/modules/runs/cancel-run.js";
import { getRunStatus } from "../src/modules/runs/get-run-status.js";
import { resumeRun } from "../src/modules/runs/resume-run.js";
import { startRun } from "../src/modules/runs/start-run.js";
import { transitionRun } from "../src/modules/runs/transition-run.js";
import { claimTask, heartbeatTask, releaseTask } from "../src/modules/tasks/lease-task.js";
import { seedTasks } from "../src/modules/tasks/seed-tasks.js";
import { transitionTask } from "../src/modules/tasks/transition-task.js";
import { createEnv, makeTempDir, openEnv, type TestEnv, writePrd } from "./helpers/env.js";

const unwrap = <T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T => {
	if (!result.ok) throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
	return result.value;
};

const start = (
	env: TestEnv,
	home: string,
	options: { forceNew?: boolean; content?: string } = {},
) => {
	const prdPath = writePrd(home, options.content);
	return startRun(env, {
		prdPath,
		projectName: "demo",
		cwd: home,
		forceNew: options.forceNew ?? false,
		deliveryTarget: "local",
	});
};

const startFresh = (env: TestEnv): Run => {
	const result = start(env, env.factoryHome);
	return unwrap(result).run;
};

const seedThree = (env: TestEnv, runId: string): Task[] =>
	unwrap(
		seedTasks(env, {
			runId,
			tasks: [
				{ key: "a", title: "A", acceptance: "a works" },
				{ key: "b", title: "B", acceptance: "b works", dependsOn: ["a"] },
				{ key: "c", title: "C", acceptance: "c works" },
			],
		}),
	);

const driveToDone = (env: TestEnv, taskId: string) => {
	let task = unwrap(claimTask(env, { taskId, owner: "w1", ttlMs: 60_000 }));
	for (const to of ["RUNNING", "VERIFYING", "DONE"] as const) {
		task = unwrap(transitionTask(env, { taskId, to, owner: "w1", expectedVersion: task.version }));
	}
};

describe("persistence across restart (E08, engine part)", () => {
	it("keeps tasks and events and never re-readies a DONE task", () => {
		const home = makeTempDir();
		const env1 = openEnv(home);
		const run = unwrap(start(env1, home)).run;
		const [a, b, c] = seedThree(env1, run.id);
		if (!a || !b || !c) throw new Error("seed failed");
		expect([a.state, b.state, c.state]).toEqual(["READY", "PENDING", "READY"]);
		driveToDone(env1, a.id);
		const eventsBefore = env1.storage.events.list(run.id, {});
		env1.storage.close();

		const env2 = openEnv(home, env1.clock);
		const tasks = env2.storage.tasks.listByRun(run.id);
		expect(Object.fromEntries(tasks.map((t) => [t.title, t.state]))).toEqual({
			A: "DONE",
			B: "READY",
			C: "READY",
		});

		const resumed = unwrap(resumeRun(env2, { runId: run.id }));
		expect(resumed.readiedTaskIds).not.toContain(a.id);
		expect(env2.storage.tasks.get(a.id)?.state).toBe("DONE");
		expect(env2.storage.tasks.get(a.id)?.attempt).toBe(1);

		const eventsAfter = env2.storage.events.list(run.id, {});
		expect(eventsAfter.slice(0, eventsBefore.length)).toEqual(eventsBefore);
		const seqs = eventsAfter.map((e) => e.seq);
		expect(seqs).toEqual(seqs.map((_, i) => i + 1));
		expect(eventsAfter.at(-1)?.type).toBe("run.resumed");
		env2.storage.close();
	});

	it("resume promotes PENDING tasks whose dependencies are DONE and recovers expired leases", () => {
		const env = createEnv();
		const run = startFresh(env);
		const [a, b, c] = seedThree(env, run.id);
		if (!a || !b || !c) throw new Error("seed failed");
		env.storage.tasks.updateState({
			id: a.id,
			expectedVersion: a.version,
			to: "DONE",
			now: env.clock.now(),
		});
		unwrap(claimTask(env, { taskId: c.id, owner: "w1", ttlMs: 1000 }));
		env.clock.advance(1000);

		const resumed = unwrap(resumeRun(env, { runId: run.id }));
		expect(resumed.readiedTaskIds.sort()).toEqual([b.id, c.id].sort());
		expect(resumed.expiredTaskIds).toEqual([c.id]);
		expect(env.storage.tasks.get(c.id)).toMatchObject({ state: "READY", leaseOwner: null });
		expect(env.storage.tasks.listAttempts(c.id).map((x) => x.outcome)).toEqual(["interrupted"]);
		expect(env.storage.tasks.get(a.id)?.state).toBe("DONE");
	});
});

describe("leases (E09)", () => {
	it("lets exactly one of two competing connections win the same claim", () => {
		const home = makeTempDir();
		const env1 = openEnv(home);
		const run = startFresh(env1);
		const [a] = seedThree(env1, run.id);
		if (!a) throw new Error("seed failed");
		const storage2 = openStorage({ file: join(home, "factory.db") });

		const attempt = (storage: typeof storage2, owner: string) =>
			storage.transaction(() =>
				storage.tasks.claim({
					taskId: a.id,
					owner,
					expectedVersion: a.version,
					ttlMs: 1000,
					now: env1.clock.now(),
				}),
			);
		const results = [attempt(env1.storage, "w1"), attempt(storage2, "w2")];
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		expect(env1.storage.tasks.get(a.id)?.leaseOwner).toBe("w1");
		storage2.close();
		env1.storage.close();
	});

	it("rejects a second claim while the lease is valid and allows it after expiry", () => {
		const env = createEnv();
		const run = startFresh(env);
		const [a] = seedThree(env, run.id);
		if (!a) throw new Error("seed failed");
		unwrap(claimTask(env, { taskId: a.id, owner: "w1", ttlMs: 1000 }));
		env.clock.advance(999);
		expect(claimTask(env, { taskId: a.id, owner: "w2", ttlMs: 1000 })).toMatchObject({
			ok: false,
			error: { code: "not_claimable" },
		});
		env.clock.advance(1);
		const taken = unwrap(claimTask(env, { taskId: a.id, owner: "w2", ttlMs: 1000 }));
		expect(taken).toMatchObject({ leaseOwner: "w2", attempt: 2, state: "LEASED" });
		expect(env.storage.tasks.listAttempts(a.id).map((x) => x.outcome)).toEqual([
			"interrupted",
			"running",
		]);
	});

	it("extends the lease on heartbeat only for the owner", () => {
		const env = createEnv();
		const run = startFresh(env);
		const [a] = seedThree(env, run.id);
		if (!a) throw new Error("seed failed");
		unwrap(claimTask(env, { taskId: a.id, owner: "w1", ttlMs: 1000 }));
		env.clock.advance(800);
		unwrap(heartbeatTask(env, { taskId: a.id, owner: "w1", ttlMs: 1000 }));
		env.clock.advance(800);
		expect(claimTask(env, { taskId: a.id, owner: "w2", ttlMs: 1000 }).ok).toBe(false);
		expect(heartbeatTask(env, { taskId: a.id, owner: "w2", ttlMs: 1000 }).ok).toBe(false);
		env.clock.advance(300);
		expect(heartbeatTask(env, { taskId: a.id, owner: "w1", ttlMs: 1000 }).ok).toBe(false);
	});

	it("releases a lease back to READY", () => {
		const env = createEnv();
		const run = startFresh(env);
		const [a] = seedThree(env, run.id);
		if (!a) throw new Error("seed failed");
		unwrap(claimTask(env, { taskId: a.id, owner: "w1", ttlMs: 1000 }));
		expect(releaseTask(env, { taskId: a.id, owner: "w2" }).ok).toBe(false);
		unwrap(releaseTask(env, { taskId: a.id, owner: "w1" }));
		expect(env.storage.tasks.get(a.id)).toMatchObject({ state: "READY", leaseOwner: null });
		expect(claimTask(env, { taskId: a.id, owner: "w2", ttlMs: 1000 }).ok).toBe(true);
	});

	it("does not claim PENDING tasks nor READY tasks with unfinished dependencies", () => {
		const home = makeTempDir();
		const env = openEnv(home);
		const run = startFresh(env);
		const [, b] = seedThree(env, run.id);
		if (!b) throw new Error("seed failed");
		expect(claimTask(env, { taskId: b.id, owner: "w1", ttlMs: 1000 }).ok).toBe(false);

		const raw = new Database(join(home, "factory.db"));
		raw.prepare("UPDATE tasks SET state = 'READY' WHERE id = ?").run(b.id);
		raw.close();
		expect(claimTask(env, { taskId: b.id, owner: "w1", ttlMs: 1000 })).toMatchObject({
			ok: false,
			error: { code: "not_claimable" },
		});
	});
});

describe("start and dedup (E16)", () => {
	it("returns the same non-terminal run for the same project and PRD, new run with forceNew", () => {
		const home = makeTempDir();
		const env = openEnv(home);
		const first = unwrap(start(env, home, { content: "# same" }));
		const prdPath = writePrd(home, "# same");
		const second = unwrap(
			startRun(env, {
				prdPath,
				projectName: "demo",
				cwd: home,
				forceNew: false,
				deliveryTarget: null,
			}),
		);
		expect(second.reused).toBe(true);
		expect(second.run.id).toBe(first.run.id);
		const forced = unwrap(
			startRun(env, {
				prdPath,
				projectName: "demo",
				cwd: home,
				forceNew: true,
				deliveryTarget: null,
			}),
		);
		expect(forced.reused).toBe(false);
		expect(forced.run.id).not.toBe(first.run.id);
	});

	it("does not reuse a terminal run", () => {
		const home = makeTempDir();
		const env = openEnv(home);
		const first = unwrap(start(env, home, { content: "# same" }));
		unwrap(cancelRun(env, { runId: first.run.id }));
		const again = unwrap(start(env, home, { content: "# same" }));
		expect(again.run.id).not.toBe(first.run.id);
	});

	it("stores an immutable byte-identical copy whose hash matches", () => {
		const home = makeTempDir();
		const env = openEnv(home);
		const content = "# PRD\n\nUnicode: ñ ✓\n";
		const { run } = unwrap(start(env, home, { content }));
		const copy = join(home, "runs", run.id, "input", "prd.md");
		expect(readFileSync(copy)).toEqual(Buffer.from(content));
		expect(run.inputHash).toBe(createHash("sha256").update(content).digest("hex"));
		expect(statSync(copy).mode & 0o222).toBe(0);
		expect(env.storage.events.list(run.id, {}).map((e) => e.type)).toEqual(["run.created"]);
	});

	it("rejects missing, non-regular and empty PRD inputs", () => {
		const home = makeTempDir();
		const env = openEnv(home);
		const base = { projectName: "demo", cwd: home, forceNew: false, deliveryTarget: null } as const;
		expect(startRun(env, { ...base, prdPath: join(home, "nope.md") })).toMatchObject({
			ok: false,
			error: { code: "prd_not_found" },
		});
		mkdirSync(join(home, "dir"));
		expect(startRun(env, { ...base, prdPath: join(home, "dir") })).toMatchObject({
			ok: false,
			error: { code: "prd_not_regular_file" },
		});
		expect(startRun(env, { ...base, prdPath: writePrd(home, "") })).toMatchObject({
			ok: false,
			error: { code: "prd_empty" },
		});
	});
});

describe("cancel (E19, engine part)", () => {
	it("cancels run and tasks including leased ones and blocks later claims and resume", () => {
		const env = createEnv();
		const run = startFresh(env);
		const [a, b, c] = seedThree(env, run.id);
		if (!a || !b || !c) throw new Error("seed failed");
		unwrap(claimTask(env, { taskId: a.id, owner: "w1", ttlMs: 60_000 }));
		driveToDone(env, c.id);

		unwrap(cancelRun(env, { runId: run.id }));
		expect(env.storage.runs.get(run.id)?.state).toBe("CANCELED");
		const states = Object.fromEntries(
			env.storage.tasks.listByRun(run.id).map((t) => [t.title, t.state]),
		);
		expect(states).toEqual({ A: "CANCELED", B: "CANCELED", C: "DONE" });
		expect(env.storage.tasks.get(a.id)?.leaseOwner).toBeNull();
		expect(claimTask(env, { taskId: a.id, owner: "w2", ttlMs: 1000 }).ok).toBe(false);
		expect(resumeRun(env, { runId: run.id })).toMatchObject({
			ok: false,
			error: { code: "run_terminal" },
		});
		const types = env.storage.events.list(run.id, {}).map((e) => e.type);
		expect(types).toContain("run.canceled");
		expect(cancelRun(env, { runId: run.id }).ok).toBe(false);
	});

	it("blocks claims at SQL level when the run is canceled even if a task row is READY", () => {
		const home = makeTempDir();
		const env = openEnv(home);
		const run = startFresh(env);
		const [a] = seedThree(env, run.id);
		if (!a) throw new Error("seed failed");
		const raw = new Database(join(home, "factory.db"));
		raw.prepare("UPDATE runs SET state = 'CANCELED' WHERE id = ?").run(run.id);
		raw.close();
		expect(claimTask(env, { taskId: a.id, owner: "w1", ttlMs: 1000 }).ok).toBe(false);
	});
});

describe("optimistic concurrency", () => {
	it("rejects stale run and task versions", () => {
		const env = createEnv();
		const run = startFresh(env);
		const [a] = seedThree(env, run.id);
		if (!a) throw new Error("seed failed");
		const now = env.clock.now();
		expect(
			env.storage.runs.updateState({
				id: run.id,
				expectedVersion: run.version,
				to: "INGESTING",
				now,
			}).ok,
		).toBe(true);
		expect(
			env.storage.runs.updateState({
				id: run.id,
				expectedVersion: run.version,
				to: "BLOCKED",
				now,
			}),
		).toMatchObject({
			ok: false,
			error: { code: "version_conflict" },
		});
		expect(
			env.storage.tasks.updateState({ id: a.id, expectedVersion: a.version, to: "BLOCKED", now })
				.ok,
		).toBe(true);
		expect(
			env.storage.tasks.updateState({ id: a.id, expectedVersion: a.version, to: "CANCELED", now }),
		).toMatchObject({
			ok: false,
			error: { code: "version_conflict" },
		});
	});

	it("rejects invalid transitions through the use cases", () => {
		const env = createEnv();
		const run = startFresh(env);
		const [a] = seedThree(env, run.id);
		if (!a) throw new Error("seed failed");
		expect(transitionRun(env, { runId: run.id, to: "SUCCEEDED" })).toMatchObject({
			ok: false,
			error: { code: "invalid_transition" },
		});
		expect(transitionTask(env, { taskId: a.id, to: "DONE" })).toMatchObject({
			ok: false,
			error: { code: "invalid_transition" },
		});
		expect(env.storage.runs.get(run.id)?.state).toBe("CREATED");
	});
});

describe("status", () => {
	it("reports counts, recent events and a next step", () => {
		const env = createEnv();
		const run = startFresh(env);
		seedThree(env, run.id);
		const status = unwrap(getRunStatus(env, { runId: run.id, eventLimit: 2 }));
		expect(status.run.state).toBe("CREATED");
		expect(status.taskCounts).toMatchObject({ READY: 2, PENDING: 1, DONE: 0 });
		expect(status.recentEvents).toHaveLength(2);
		expect(status.recentEvents.at(-1)?.seq).toBeGreaterThan(status.recentEvents[0]?.seq ?? 0);
		expect(status.nextStep.length).toBeGreaterThan(0);
		expect(getRunStatus(env, { runId: "nope", eventLimit: 2 })).toMatchObject({
			ok: false,
			error: { code: "run_not_found" },
		});
	});
});
