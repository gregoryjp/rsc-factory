import Database from "better-sqlite3";
import { z } from "zod";
import type { Storage } from "../../modules/storage.js";
import { fail } from "../../shared/result.js";
import { createBudgetRepository } from "./budget-repository.js";
import { createCheckRepository } from "./check-repository.js";
import { createEventLog } from "./event-log.js";
import { MIGRATIONS } from "./migrations.js";
import {
	createArtifactRepository,
	createRoleAttemptRepository,
	createSpecRepository,
	createTaskMetaRepository,
} from "./planning-repositories.js";
import { createRetryRepository, createReviewRepository } from "./review-repository.js";
import { createProjectRepository, createRunRepository } from "./run-repository.js";
import { createTaskBuildRepository } from "./task-build-repository.js";
import { createTaskRepository } from "./task-repository.js";

const appliedVersions = (db: Database.Database): number[] =>
	db
		.prepare("SELECT version FROM schema_migrations ORDER BY version")
		.all()
		.map((row) => z.object({ version: z.number() }).parse(row).version);

const applyMigrations = (db: Database.Database): void => {
	db.exec(
		"CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
	);
	const applied = new Set(appliedVersions(db));
	for (const migration of MIGRATIONS) {
		if (applied.has(migration.version)) continue;
		db.exec("BEGIN IMMEDIATE");
		try {
			db.exec(migration.sql);
			db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
				migration.version,
				migration.name,
				Date.now(),
			);
			db.exec("COMMIT");
		} catch (cause) {
			db.exec("ROLLBACK");
			throw cause;
		}
	}
};

export const openStorage = (config: { file: string }): Storage => {
	const db = new Database(config.file);
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");
	db.pragma("busy_timeout = 5000");
	applyMigrations(db);

	let depth = 0;

	return {
		projects: createProjectRepository(db),
		runs: createRunRepository(db),
		tasks: createTaskRepository(db),
		events: createEventLog(db),
		specs: createSpecRepository(db),
		artifacts: createArtifactRepository(db),
		roleAttempts: createRoleAttemptRepository(db),
		taskMeta: createTaskMetaRepository(db),
		checks: createCheckRepository(db),
		taskBuilds: createTaskBuildRepository(db),
		reviews: createReviewRepository(db),
		retries: createRetryRepository(db),
		budgets: createBudgetRepository(db),
		transaction: (work) => {
			if (depth > 0) return work();
			db.exec("BEGIN IMMEDIATE");
			depth = 1;
			try {
				const result = work();
				db.exec(result.ok ? "COMMIT" : "ROLLBACK");
				return result;
			} catch (cause) {
				db.exec("ROLLBACK");
				if (
					cause instanceof Error &&
					String((cause as { code?: unknown }).code).startsWith("SQLITE_")
				) {
					return fail("storage_error", cause.message);
				}
				throw cause;
			} finally {
				depth = 0;
			}
		},
		appliedMigrations: () => appliedVersions(db),
		close: () => {
			db.close();
		},
	};
};
