import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { AgentResultSchema } from "../src/contracts/agent-result.js";
import type { Task } from "../src/contracts/entities.js";
import {
	LEASE_HOLDING_STATES,
	transitionTask as validateTask,
} from "../src/domain/task-machine.js";
import { openStorage } from "../src/infrastructure/storage/sqlite-storage.js";
import { getRunStatus } from "../src/modules/runs/get-run-status.js";
import { resumeRun } from "../src/modules/runs/resume-run.js";
import { startRun } from "../src/modules/runs/start-run.js";
import { transitionRun } from "../src/modules/runs/transition-run.js";
import { claimTask } from "../src/modules/tasks/lease-task.js";
import { seedTasks } from "../src/modules/tasks/seed-tasks.js";
import { transitionTask } from "../src/modules/tasks/transition-task.js";
import { err, ok } from "../src/shared/result.js";
import { createEnv, makeTempDir, openEnv, type TestEnv, writePrd } from "./helpers/env.js";

const unwrap = <T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T => {
	if (!result.ok) throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
	return result.value;
};

const startBase = {
	projectName: "demo",
	forceNew: false,
	deliveryTarget: null,
} as const;

const newRun = (env: TestEnv) =>
	unwrap(startRun(env, { ...startBase, prdPath: writePrd(env.factoryHome), cwd: env.factoryHome }))
		.run;

const seedOne = (env: TestEnv, runId: string): Task => {
	const [task] = unwrap(
		seedTasks(env, { runId, tasks: [{ key: "a", title: "A", acceptance: "ok" }] }),
	);
	if (!task) throw new Error("seed failed");
	return task;
};

const forceLease = (home: string, taskId: string, state: string, expiresAt: number) => {
	const raw = new Database(join(home, "factory.db"));
	raw
		.prepare(
			"UPDATE tasks SET state = ?, lease_owner = 'ghost', lease_expires_at = ?, heartbeat_at = ? WHERE id = ?",
		)
		.run(state, expiresAt, expiresAt, taskId);
	raw.close();
};

describe("lease-holding transitions", () => {
	it("makes LEASED reachable only through claim", () => {
		expect(validateTask("READY", "LEASED")).toMatchObject({
			ok: false,
			error: { code: "invalid_transition" },
		});
		const env = createEnv();
		const task = seedOne(env, newRun(env).id);
		expect(transitionTask(env, { taskId: task.id, to: "LEASED" })).toMatchObject({
			ok: false,
			error: { code: "invalid_transition" },
		});
		expect(env.storage.tasks.get(task.id)).toMatchObject({ state: "READY", leaseOwner: null });
	});

	it("requires owner and version for lease-holding tasks", () => {
		const env = createEnv();
		const task = seedOne(env, newRun(env).id);
		const claimed = unwrap(claimTask(env, { taskId: task.id, owner: "w1", ttlMs: 1000 }));
		expect(transitionTask(env, { taskId: task.id, to: "RUNNING" })).toMatchObject({
			ok: false,
			error: { code: "lease_required" },
		});
		expect(
			transitionTask(env, {
				taskId: task.id,
				to: "RUNNING",
				owner: "w2",
				expectedVersion: claimed.version,
			}),
		).toMatchObject({ ok: false, error: { code: "lease_lost" } });
		expect(
			transitionTask(env, {
				taskId: task.id,
				to: "RUNNING",
				owner: "w1",
				expectedVersion: claimed.version,
			}).ok,
		).toBe(true);
	});

	it("rejects a stale worker after its lease expired and was reclaimed", () => {
		const env = createEnv();
		const run = newRun(env);
		const [a, b] = unwrap(
			seedTasks(env, {
				runId: run.id,
				tasks: [
					{ key: "a", title: "A", acceptance: "ok" },
					{ key: "b", title: "B", acceptance: "ok", dependsOn: ["a"] },
				],
			}),
		);
		if (!a || !b) throw new Error("seed failed");
		const first = unwrap(claimTask(env, { taskId: a.id, owner: "w1", ttlMs: 1000 }));
		const running = unwrap(
			transitionTask(env, {
				taskId: a.id,
				to: "RUNNING",
				owner: "w1",
				expectedVersion: first.version,
			}),
		);
		env.clock.advance(1000);
		const stale = {
			taskId: a.id,
			to: "VERIFYING",
			owner: "w1",
			expectedVersion: running.version,
		} as const;
		expect(transitionTask(env, stale)).toMatchObject({ ok: false, error: { code: "lease_lost" } });

		const second = unwrap(claimTask(env, { taskId: a.id, owner: "w2", ttlMs: 1000 }));
		const staleAfterReclaim = { ...stale, to: "RUNNING" } as const;
		expect(transitionTask(env, staleAfterReclaim)).toMatchObject({
			ok: false,
			error: { code: "version_conflict" },
		});
		expect(
			transitionTask(env, { ...staleAfterReclaim, expectedVersion: second.version }),
		).toMatchObject({ ok: false, error: { code: "lease_lost" } });
		expect(env.storage.tasks.get(a.id)).toMatchObject({ state: "LEASED", leaseOwner: "w2" });
		expect(env.storage.tasks.get(b.id)?.state).toBe("PENDING");
	});
});

describe.each(LEASE_HOLDING_STATES)("expired lease in %s", (state) => {
	it("is recovered by resume", () => {
		const env = createEnv();
		const task = seedOne(env, newRun(env).id);
		forceLease(env.factoryHome, task.id, state, env.clock.now());
		const summary = unwrap(resumeRun(env, { runId: task.runId }));
		expect(summary.expiredTaskIds).toEqual([task.id]);
		expect(env.storage.tasks.get(task.id)).toMatchObject({ state: "READY", leaseOwner: null });
	});

	it("is claimable by another worker, but not while still valid", () => {
		const env = createEnv();
		const task = seedOne(env, newRun(env).id);
		forceLease(env.factoryHome, task.id, state, env.clock.now() + 500);
		expect(claimTask(env, { taskId: task.id, owner: "w2", ttlMs: 1000 }).ok).toBe(false);
		env.clock.advance(500);
		expect(unwrap(claimTask(env, { taskId: task.id, owner: "w2", ttlMs: 1000 }))).toMatchObject({
			state: "LEASED",
			leaseOwner: "w2",
		});
	});
});

describe("seedTasks input errors", () => {
	it("rejects duplicate dependencies with a Result instead of throwing", () => {
		const env = createEnv();
		const run = newRun(env);
		const result = seedTasks(env, {
			runId: run.id,
			tasks: [
				{ key: "a", title: "A", acceptance: "ok" },
				{ key: "b", title: "B", acceptance: "ok", dependsOn: ["a", "a"] },
			],
		});
		expect(result).toMatchObject({ ok: false, error: { code: "invalid_dependencies" } });
		expect(env.storage.tasks.listByRun(run.id)).toEqual([]);
	});
});

describe("status for BLOCKED runs", () => {
	it("states the recorded cause and does not promise that resume unblocks", () => {
		const env = createEnv();
		const run = newRun(env);
		unwrap(
			transitionRun(env, { runId: run.id, to: "BLOCKED", reason: "needs hosting credentials" }),
		);
		const { nextStep } = unwrap(getRunStatus(env, { runId: run.id, eventLimit: 5 }));
		expect(nextStep).toContain("needs hosting credentials");
		expect(nextStep).not.toMatch(/then `factory resume`/);
	});

	it("says no cause was recorded when none was given", () => {
		const env = createEnv();
		const run = newRun(env);
		unwrap(transitionRun(env, { runId: run.id, to: "BLOCKED" }));
		expect(unwrap(getRunStatus(env, { runId: run.id, eventLimit: 5 })).nextStep).toMatch(
			/no cause recorded/i,
		);
	});
});

describe("Storage.transaction", () => {
	const project = (id: string) => ({
		id,
		name: id,
		authorizedPath: "/x",
		preset: null,
		policyVersion: "0",
		createdAt: 1,
	});

	it("rolls back and rethrows when the work throws a programmer error", () => {
		const env = createEnv();
		expect(() =>
			env.storage.transaction(() => {
				env.storage.projects.insert(project("p1"));
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(env.storage.projects.findByName("p1")).toBeUndefined();
	});

	it("rolls back when the work returns an error Result and commits on ok", () => {
		const env = createEnv();
		const failed = env.storage.transaction(() => {
			env.storage.projects.insert(project("p2"));
			return err({ code: "nope" });
		});
		expect(failed.ok).toBe(false);
		expect(env.storage.projects.findByName("p2")).toBeUndefined();
		env.storage.transaction(() => {
			env.storage.projects.insert(project("p3"));
			return ok(null);
		});
		expect(env.storage.projects.findByName("p3")).toBeDefined();
	});

	it("joins the outer transaction when nested", () => {
		const env = createEnv();
		const outer = env.storage.transaction(() => {
			const inner = env.storage.transaction(() => {
				env.storage.projects.insert(project("p4"));
				return ok(null);
			});
			expect(inner.ok).toBe(true);
			return err({ code: "outer-fails" });
		});
		expect(outer.ok).toBe(false);
		expect(env.storage.projects.findByName("p4")).toBeUndefined();
	});

	it("converts SQLite errors into a storage_error Result and rolls back", () => {
		const env = createEnv();
		const result = env.storage.transaction(() => {
			env.storage.projects.insert(project("p5"));
			env.storage.projects.insert(project("p5"));
			return ok(null);
		});
		expect(result).toMatchObject({ ok: false, error: { code: "storage_error" } });
		expect(env.storage.projects.findByName("p5")).toBeUndefined();
	});
});

describe("event sequence with two connections", () => {
	it("stays unique and contiguous when both append to the same run", () => {
		const home = makeTempDir();
		const env1 = openEnv(home);
		const run = newRun(env1);
		const storage2 = openStorage({ file: join(home, "factory.db") });
		for (let i = 0; i < 10; i += 1) {
			for (const storage of [env1.storage, storage2]) {
				storage.transaction(() => {
					storage.events.append({ runId: run.id, type: "run.resumed", now: i });
					return ok(null);
				});
			}
		}
		const seqs = env1.storage.events.list(run.id, {}).map((e) => e.seq);
		expect(seqs).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
		storage2.close();
	});
});

describe("start dedup and intake", () => {
	it("returns the same run for identical content via another path or a symlink", () => {
		const home = makeTempDir();
		const env = openEnv(home);
		const content = "# identical\n";
		const original = writePrd(home, content);
		const first = unwrap(startRun(env, { ...startBase, prdPath: original, cwd: home }));
		const copyPath = writePrd(home, content);
		const link = join(home, "link.md");
		symlinkSync(original, link);
		const viaCopy = unwrap(startRun(env, { ...startBase, prdPath: copyPath, cwd: home }));
		const viaLink = unwrap(startRun(env, { ...startBase, prdPath: link, cwd: home }));
		expect(viaCopy).toMatchObject({ reused: true, run: { id: first.run.id } });
		expect(viaLink).toMatchObject({ reused: true, run: { id: first.run.id } });
	});

	it("rejects a symlink to a directory and a dangling symlink", () => {
		const home = makeTempDir();
		const env = openEnv(home);
		mkdirSync(join(home, "d"));
		symlinkSync(join(home, "d"), join(home, "to-dir"));
		symlinkSync(join(home, "missing"), join(home, "dangling"));
		expect(startRun(env, { ...startBase, prdPath: join(home, "to-dir"), cwd: home })).toMatchObject(
			{
				ok: false,
				error: { code: "prd_not_regular_file" },
			},
		);
		expect(
			startRun(env, { ...startBase, prdPath: join(home, "dangling"), cwd: home }),
		).toMatchObject({
			ok: false,
			error: { code: "prd_not_found" },
		});
	});

	it("fails explicitly when dedup finds a run with a different delivery target", () => {
		const home = makeTempDir();
		const env = openEnv(home);
		const prdPath = writePrd(home, "# d");
		const base = { ...startBase, prdPath, cwd: home };
		unwrap(startRun(env, { ...base, deliveryTarget: "local" }));
		expect(startRun(env, { ...base, deliveryTarget: "production" })).toMatchObject({
			ok: false,
			error: { code: "delivery_mismatch" },
		});
		expect(startRun(env, { ...base, deliveryTarget: "local" })).toMatchObject({
			ok: true,
			value: { reused: true },
		});
		expect(startRun(env, { ...base, deliveryTarget: null })).toMatchObject({
			ok: true,
			value: { reused: true },
		});
		expect(startRun(env, { ...base, deliveryTarget: "production", forceNew: true }).ok).toBe(true);
	});
});

describe("AgentResult contract", () => {
	it("accepts the three variants", () => {
		for (const value of [
			{ status: "completed", artifactIds: ["a"], evidenceIds: [] },
			{ status: "blocked", reason: "x", requiredInputs: ["token"] },
			{ status: "failed", errorCode: "E1", retryable: false },
		]) {
			expect(AgentResultSchema.safeParse(value).success, value.status).toBe(true);
		}
	});

	it("rejects unknown status, missing fields and unknown extra fields", () => {
		for (const value of [
			{ status: "approved", artifactIds: [], evidenceIds: [] },
			{ status: "completed", artifactIds: [] },
			{ status: "failed", errorCode: "E1" },
			{ status: "completed", artifactIds: [], evidenceIds: [], gateApproved: true },
			{ status: "blocked", reason: "x", requiredInputs: [], overridePolicy: "yes" },
			{ status: "failed", errorCode: "E1", retryable: false, secret: "s" },
			{ artifactIds: [], evidenceIds: [] },
		]) {
			expect(AgentResultSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
		}
	});
});
