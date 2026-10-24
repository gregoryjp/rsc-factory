import type Database from "better-sqlite3";
import { z } from "zod";
import { ProjectSchema, type Run, RunSchema } from "../../contracts/entities.js";
import { TargetKindSchema } from "../../contracts/planning.js";
import { DeliveryTargetSchema, RunStateSchema } from "../../contracts/states.js";
import { TERMINAL_RUN_STATES } from "../../domain/run-machine.js";
import type { ProjectRepository, RunRepository } from "../../modules/runs/ports.js";
import { fail, ok } from "../../shared/result.js";

const RunRow = z
	.object({
		id: z.string(),
		project_id: z.string(),
		input_hash: z.string(),
		input_path: z.string(),
		state: RunStateSchema,
		delivery_target: DeliveryTargetSchema.nullable(),
		cost_limit_usd: z.number().nullable(),
		target_path: z.string().nullable(),
		target_kind: TargetKindSchema.nullable(),
		provider_mode: z.enum(["real", "fake"]).nullable(),
		preset_ids: z.string().transform((raw): unknown => JSON.parse(raw)),
		version: z.number(),
		created_at: z.number(),
		updated_at: z.number(),
	})
	.transform(
		(row): Run =>
			RunSchema.parse({
				id: row.id,
				projectId: row.project_id,
				inputHash: row.input_hash,
				inputPath: row.input_path,
				state: row.state,
				deliveryTarget: row.delivery_target,
				costLimitUsd: row.cost_limit_usd,
				targetPath: row.target_path,
				targetKind: row.target_kind,
				presetIds: row.preset_ids,
				providerMode: row.provider_mode,
				version: row.version,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
			}),
	);

const ProjectRow = z
	.object({
		id: z.string(),
		name: z.string(),
		authorized_path: z.string(),
		preset: z.string().nullable(),
		policy_version: z.string(),
		created_at: z.number(),
	})
	.transform((row) =>
		ProjectSchema.parse({
			id: row.id,
			name: row.name,
			authorizedPath: row.authorized_path,
			preset: row.preset,
			policyVersion: row.policy_version,
			createdAt: row.created_at,
		}),
	);

const quoted = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(", ");

export const createProjectRepository = (db: Database.Database): ProjectRepository => ({
	findByName: (name) => {
		const row = db.prepare("SELECT * FROM projects WHERE name = ?").get(name);
		return row === undefined ? undefined : ProjectRow.parse(row);
	},
	findById: (id) => {
		const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
		return row === undefined ? undefined : ProjectRow.parse(row);
	},
	insert: (project) => {
		db.prepare(
			`INSERT INTO projects (id, name, authorized_path, preset, policy_version, created_at)
			 VALUES (@id, @name, @authorizedPath, @preset, @policyVersion, @createdAt)`,
		).run(project);
	},
});

export const createRunRepository = (db: Database.Database): RunRepository => {
	const get: RunRepository["get"] = (id) => {
		const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
		return row === undefined ? undefined : RunRow.parse(row);
	};

	return {
		get,
		insert: (run) => {
			db.prepare(
				`INSERT INTO runs (id, project_id, input_hash, input_path, state, delivery_target,
				   cost_limit_usd, target_path, target_kind, preset_ids, provider_mode, version, created_at, updated_at)
				 VALUES (@id, @projectId, @inputHash, @inputPath, @state, @deliveryTarget,
				   @costLimitUsd, @targetPath, @targetKind, @presetIds, @providerMode, @version, @createdAt, @updatedAt)`,
			).run({ ...run, presetIds: JSON.stringify(run.presetIds) });
		},
		setProviderMode: (id, mode) => {
			db.prepare("UPDATE runs SET provider_mode = ? WHERE id = ?").run(mode, id);
		},
		setPresets: (id, presetIds) => {
			db.prepare("UPDATE runs SET preset_ids = ? WHERE id = ?").run(JSON.stringify(presetIds), id);
		},
		setDeliveryTarget: (id, target) => {
			db.prepare("UPDATE runs SET delivery_target = ? WHERE id = ?").run(target, id);
		},
		findActiveByInput: (projectId, inputHash) => {
			const row = db
				.prepare(
					`SELECT * FROM runs WHERE project_id = ? AND input_hash = ?
					 AND state NOT IN (${quoted(TERMINAL_RUN_STATES)})
					 ORDER BY created_at DESC, rowid DESC LIMIT 1`,
				)
				.get(projectId, inputHash);
			return row === undefined ? undefined : RunRow.parse(row);
		},
		findLatestByInput: (projectId, inputHash) => {
			const row = db
				.prepare(
					`SELECT * FROM runs WHERE project_id = ? AND input_hash = ?
					 ORDER BY created_at DESC, rowid DESC LIMIT 1`,
				)
				.get(projectId, inputHash);
			return row === undefined ? undefined : RunRow.parse(row);
		},
		updateState: ({ id, expectedVersion, to, now }) => {
			const info = db
				.prepare(
					`UPDATE runs SET state = @to, version = version + 1, updated_at = @now
					 WHERE id = @id AND version = @expectedVersion`,
				)
				.run({ id, expectedVersion, to, now });
			const updated = get(id);
			if (info.changes === 1 && updated) return ok(updated);
			return updated
				? fail(
						"version_conflict",
						`Run ${id} is at version ${updated.version}, expected ${expectedVersion}`,
					)
				: fail("not_found", `Run ${id} not found`);
		},
	};
};
