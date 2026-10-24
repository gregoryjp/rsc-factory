import type Database from "better-sqlite3";
import { z } from "zod";
import { type Task, TaskSchema } from "../../contracts/entities.js";
import { AttemptOutcomeSchema, type TaskState, TaskStateSchema } from "../../contracts/states.js";
import { TERMINAL_RUN_STATES } from "../../domain/run-machine.js";
import { keepsLeaseAfter, LEASE_HOLDING_STATES } from "../../domain/task-machine.js";
import type { Attempt, TaskRepository } from "../../modules/tasks/ports.js";
import { fail, ok } from "../../shared/result.js";

const TaskRow = z.object({
	id: z.string(),
	run_id: z.string(),
	title: z.string(),
	acceptance: z.string(),
	state: TaskStateSchema,
	attempt: z.number(),
	version: z.number(),
	lease_owner: z.string().nullable(),
	lease_expires_at: z.number().nullable(),
	heartbeat_at: z.number().nullable(),
	base_commit: z.string().nullable(),
	created_at: z.number(),
	updated_at: z.number(),
});
type TaskRowType = z.infer<typeof TaskRow>;

const AttemptRow = z
	.object({
		id: z.number(),
		task_id: z.string(),
		number: z.number(),
		owner: z.string(),
		outcome: AttemptOutcomeSchema,
		started_at: z.number(),
		ended_at: z.number().nullable(),
	})
	.transform(
		(row): Attempt => ({
			id: row.id,
			taskId: row.task_id,
			number: row.number,
			owner: row.owner,
			outcome: row.outcome,
			startedAt: row.started_at,
			endedAt: row.ended_at,
		}),
	);

const quoted = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(", ");

const LEASE_STATES_SQL = quoted(LEASE_HOLDING_STATES);

const NON_CLAIMABLE_RUN_STATES = [...TERMINAL_RUN_STATES, "BLOCKED"];

const CLOSING_OUTCOME: Partial<Record<TaskState, "completed" | "failed" | "interrupted">> = {
	DONE: "completed",
	FAILED: "failed",
};

const NO_DEPENDENCY_PENDING = `NOT EXISTS (
	SELECT 1 FROM task_dependencies d JOIN tasks dep ON dep.id = d.depends_on_task_id
	WHERE d.task_id = tasks.id AND dep.state != 'DONE')`;

export const createTaskRepository = (db: Database.Database): TaskRepository => {
	const hydrate = (row: TaskRowType): Task => {
		const deps = db
			.prepare(
				"SELECT depends_on_task_id AS id FROM task_dependencies WHERE task_id = ? ORDER BY depends_on_task_id",
			)
			.all(row.id)
			.map((dep) => z.object({ id: z.string() }).parse(dep).id);
		return TaskSchema.parse({
			id: row.id,
			runId: row.run_id,
			title: row.title,
			acceptance: row.acceptance,
			state: row.state,
			attempt: row.attempt,
			version: row.version,
			dependsOn: deps,
			leaseOwner: row.lease_owner,
			leaseExpiresAt: row.lease_expires_at,
			heartbeatAt: row.heartbeat_at,
			baseCommit: row.base_commit,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		});
	};

	const get: TaskRepository["get"] = (id) => {
		const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
		return row === undefined ? undefined : hydrate(TaskRow.parse(row));
	};

	const listWhere = (where: string, ...params: unknown[]): Task[] =>
		db
			.prepare(`SELECT * FROM tasks WHERE ${where} ORDER BY created_at, rowid`)
			.all(...params)
			.map((row) => hydrate(TaskRow.parse(row)));

	const closeOpenAttempts = (taskId: string, outcome: string, now: number): void => {
		db.prepare(
			"UPDATE attempts SET outcome = ?, ended_at = ? WHERE task_id = ? AND outcome = 'running'",
		).run(outcome, now, taskId);
	};

	const requireTask = (id: string): Task => {
		const task = get(id);
		if (!task) throw new Error(`Task ${id} disappeared inside a transaction`);
		return task;
	};

	return {
		get,
		insertMany: (tasks) => {
			const insertTask = db.prepare(
				`INSERT INTO tasks (id, run_id, title, acceptance, state, attempt, version, created_at, updated_at)
				 VALUES (@id, @runId, @title, @acceptance, @state, 0, 1, @now, @now)`,
			);
			const insertDep = db.prepare(
				"INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)",
			);
			for (const task of tasks) insertTask.run(task);
			for (const task of tasks) for (const dep of task.dependsOn) insertDep.run(task.id, dep);
		},
		listByRun: (runId) => listWhere("run_id = ?", runId),
		countByState: (runId) => {
			const counts = Object.fromEntries(TaskStateSchema.options.map((s) => [s, 0])) as Record<
				TaskState,
				number
			>;
			const rows = db
				.prepare("SELECT state, COUNT(*) AS n FROM tasks WHERE run_id = ? GROUP BY state")
				.all(runId);
			for (const row of rows) {
				const parsed = z.object({ state: TaskStateSchema, n: z.number() }).parse(row);
				counts[parsed.state] = parsed.n;
			}
			return counts;
		},
		listAttempts: (taskId) =>
			db
				.prepare("SELECT * FROM attempts WHERE task_id = ? ORDER BY number, id")
				.all(taskId)
				.map((row) => AttemptRow.parse(row)),
		listExpiredLeases: (runId, now) =>
			listWhere(
				`run_id = ? AND state IN (${LEASE_STATES_SQL}) AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
				runId,
				now,
			),
		listPromotable: (runId) =>
			listWhere(`run_id = ? AND state = 'PENDING' AND ${NO_DEPENDENCY_PENDING}`, runId),
		listDependents: (taskId) =>
			listWhere(
				"id IN (SELECT task_id FROM task_dependencies WHERE depends_on_task_id = ?)",
				taskId,
			),
		updateState: ({ id, expectedVersion, to, now, owner }) => {
			const info = db
				.prepare(
					`UPDATE tasks SET state = @to, version = version + 1, updated_at = @now,
					   lease_owner = CASE WHEN @keepLease = 1 THEN lease_owner END,
					   lease_expires_at = CASE WHEN @keepLease = 1 THEN lease_expires_at END,
					   heartbeat_at = CASE WHEN @keepLease = 1 THEN heartbeat_at END
					 WHERE id = @id AND version = @expectedVersion
					   AND (@owner IS NULL OR (lease_owner = @owner AND lease_expires_at > @now))`,
				)
				.run({
					id,
					expectedVersion,
					to,
					now,
					owner: owner ?? null,
					keepLease: keepsLeaseAfter(to) ? 1 : 0,
				});
			const updated = get(id);
			if (info.changes !== 1 || !updated) {
				if (!updated) return fail("not_found", `Task ${id} not found`);
				return updated.version !== expectedVersion
					? fail(
							"version_conflict",
							`Task ${id} is at version ${updated.version}, expected ${expectedVersion}`,
						)
					: fail("lease_lost", `Task ${id} is not leased by ${owner ?? "?"} or the lease expired`);
			}
			if (!keepsLeaseAfter(to)) closeOpenAttempts(id, CLOSING_OUTCOME[to] ?? "interrupted", now);
			return ok(updated);
		},
		claim: ({ taskId, owner, expectedVersion, ttlMs, now }) => {
			const info = db
				.prepare(
					`UPDATE tasks SET state = 'LEASED', attempt = attempt + 1, version = version + 1,
					   lease_owner = @owner, lease_expires_at = @expiresAt, heartbeat_at = @now, updated_at = @now
					 WHERE id = @taskId AND version = @expectedVersion
					   AND (state = 'READY'
					     OR (state IN (${LEASE_STATES_SQL}) AND lease_expires_at IS NOT NULL AND lease_expires_at <= @now))
					   AND ${NO_DEPENDENCY_PENDING}
					   AND EXISTS (SELECT 1 FROM runs r WHERE r.id = tasks.run_id
					     AND r.state NOT IN (${quoted(NON_CLAIMABLE_RUN_STATES)}))`,
				)
				.run({ taskId, owner, expectedVersion, now, expiresAt: now + ttlMs });
			if (info.changes !== 1) return fail("not_claimable", `Task ${taskId} could not be claimed`);
			closeOpenAttempts(taskId, "interrupted", now);
			const task = requireTask(taskId);
			db.prepare(
				"INSERT INTO attempts (task_id, number, owner, outcome, started_at) VALUES (?, ?, ?, 'running', ?)",
			).run(taskId, task.attempt, owner, now);
			return ok(task);
		},
		heartbeat: ({ taskId, owner, ttlMs, now }) => {
			const info = db
				.prepare(
					`UPDATE tasks SET lease_expires_at = @expiresAt, heartbeat_at = @now, updated_at = @now
					 WHERE id = @taskId AND lease_owner = @owner AND state IN (${LEASE_STATES_SQL})
					   AND lease_expires_at > @now`,
				)
				.run({ taskId, owner, now, expiresAt: now + ttlMs });
			return info.changes === 1
				? ok(requireTask(taskId))
				: fail("not_lease_owner", `Task ${taskId} is not leased by ${owner} or the lease expired`);
		},
		release: ({ taskId, owner, now }) => {
			const info = db
				.prepare(
					`UPDATE tasks SET state = 'READY', version = version + 1, updated_at = @now,
					   lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL
					 WHERE id = @taskId AND lease_owner = @owner AND state IN (${LEASE_STATES_SQL})`,
				)
				.run({ taskId, owner, now });
			if (info.changes !== 1) {
				return fail("not_lease_owner", `Task ${taskId} is not leased by ${owner}`);
			}
			closeOpenAttempts(taskId, "released", now);
			return ok(requireTask(taskId));
		},
	};
};
