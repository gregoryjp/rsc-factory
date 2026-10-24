import type Database from "better-sqlite3";
import { z } from "zod";
import { type Check, CheckSchema } from "../../contracts/entities.js";
import type { CheckRepository } from "../../modules/execution/ports.js";

const CheckRow = z
	.object({
		id: z.string(),
		run_id: z.string(),
		task_id: z.string().nullable(),
		argv: z.string().transform((raw): unknown => JSON.parse(raw)),
		cwd: z.string(),
		exit_code: z.number(),
		duration_ms: z.number(),
		commit_sha: z.string(),
		log_path: z.string(),
		log_sha256: z.string(),
		isolated: z.number(),
		created_at: z.number(),
	})
	.transform(
		(row): Check =>
			CheckSchema.parse({
				id: row.id,
				runId: row.run_id,
				taskId: row.task_id,
				argv: row.argv,
				cwd: row.cwd,
				exitCode: row.exit_code,
				durationMs: row.duration_ms,
				commitSha: row.commit_sha,
				logPath: row.log_path,
				logSha256: row.log_sha256,
				isolated: row.isolated === 1,
				createdAt: row.created_at,
			}),
	);

export const createCheckRepository = (db: Database.Database): CheckRepository => ({
	insert: (check) => {
		db.prepare(
			`INSERT INTO checks (id, run_id, task_id, argv, cwd, exit_code, duration_ms, commit_sha,
				log_path, log_sha256, isolated, created_at)
			 VALUES (@id, @runId, @taskId, @argv, @cwd, @exitCode, @durationMs, @commitSha,
				@logPath, @logSha256, @isolated, @createdAt)`,
		).run({ ...check, argv: JSON.stringify(check.argv), isolated: check.isolated ? 1 : 0 });
	},
	get: (id) => {
		const row = db.prepare("SELECT * FROM checks WHERE id = ?").get(id);
		return row === undefined ? undefined : CheckRow.parse(row);
	},
	listByRun: (runId) =>
		db
			.prepare("SELECT * FROM checks WHERE run_id = ? ORDER BY created_at, rowid")
			.all(runId)
			.map((row) => CheckRow.parse(row)),
});
