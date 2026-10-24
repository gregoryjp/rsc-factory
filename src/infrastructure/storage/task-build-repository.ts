import type Database from "better-sqlite3";
import { z } from "zod";
import type { BuildPhase, TaskBuild, TaskBuildRepository } from "../../modules/execution/ports.js";

const PHASES = [
	"started",
	"red_committed",
	"red_observed",
	"green_committed",
	"green_observed",
	"reviewing",
	"reviewed",
	"merged",
	"done",
	"blocked",
] as const satisfies readonly BuildPhase[];

const JsonStrings = z.string().transform((raw) => z.array(z.string()).parse(JSON.parse(raw)));

const Row = z
	.object({
		task_id: z.string(),
		run_id: z.string(),
		phase: z.enum(PHASES),
		base_commit: z.string(),
		red_commit: z.string().nullable(),
		head_commit: z.string().nullable(),
		pre_merge_commit: z.string().nullable(),
		integration_commit: z.string().nullable(),
		reviewed_commit: z.string().nullable(),
		test_files: JsonStrings,
		red_repairs: z.number(),
		repairs: z.number(),
		requires_review: z.number(),
		protected_paths: JsonStrings,
		blocked_reason: z.string().nullable(),
		last_check_id: z.string().nullable(),
		updated_at: z.number(),
	})
	.transform(
		(row): TaskBuild => ({
			taskId: row.task_id,
			runId: row.run_id,
			phase: row.phase,
			baseCommit: row.base_commit,
			redCommit: row.red_commit,
			headCommit: row.head_commit,
			preMergeCommit: row.pre_merge_commit,
			integrationCommit: row.integration_commit,
			reviewedCommit: row.reviewed_commit,
			testFiles: row.test_files,
			redRepairs: row.red_repairs,
			repairs: row.repairs,
			requiresReview: row.requires_review === 1,
			protectedPaths: row.protected_paths,
			blockedReason: row.blocked_reason,
			lastCheckId: row.last_check_id,
			updatedAt: row.updated_at,
		}),
	);

export const createTaskBuildRepository = (db: Database.Database): TaskBuildRepository => ({
	get: (taskId) => {
		const row = db.prepare("SELECT * FROM task_builds WHERE task_id = ?").get(taskId);
		return row === undefined ? undefined : Row.parse(row);
	},
	upsert: (build) => {
		db.prepare(
			`INSERT INTO task_builds (task_id, run_id, phase, base_commit, red_commit, head_commit,
				pre_merge_commit, integration_commit, reviewed_commit, test_files, red_repairs, repairs, requires_review,
				protected_paths, blocked_reason, last_check_id, updated_at)
			 VALUES (@taskId, @runId, @phase, @baseCommit, @redCommit, @headCommit, @preMergeCommit,
				@integrationCommit, @reviewedCommit, @testFiles, @redRepairs, @repairs, @requiresReview, @protectedPaths,
				@blockedReason, @lastCheckId, @updatedAt)
			 ON CONFLICT(task_id) DO UPDATE SET phase = excluded.phase, red_commit = excluded.red_commit,
				head_commit = excluded.head_commit, pre_merge_commit = excluded.pre_merge_commit,
				integration_commit = excluded.integration_commit, reviewed_commit = excluded.reviewed_commit, test_files = excluded.test_files,
				red_repairs = excluded.red_repairs, repairs = excluded.repairs,
				requires_review = excluded.requires_review, protected_paths = excluded.protected_paths,
				blocked_reason = excluded.blocked_reason, last_check_id = excluded.last_check_id,
				updated_at = excluded.updated_at`,
		).run({
			...build,
			testFiles: JSON.stringify(build.testFiles),
			protectedPaths: JSON.stringify(build.protectedPaths),
			requiresReview: build.requiresReview ? 1 : 0,
		});
	},
	remove: (taskId) => {
		db.prepare("DELETE FROM task_builds WHERE task_id = ?").run(taskId);
	},
	listByRun: (runId) =>
		db
			.prepare("SELECT * FROM task_builds WHERE run_id = ? ORDER BY updated_at, rowid")
			.all(runId)
			.map((row) => Row.parse(row)),
});
