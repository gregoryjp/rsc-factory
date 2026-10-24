import type Database from "better-sqlite3";
import { z } from "zod";
import {
	type Artifact,
	ArtifactKindSchema,
	AssumptionSchema,
	ContradictionSchema,
	DecisionSchema,
	RequirementSchema,
	RiskSchema,
	RoleSchema,
} from "../../contracts/planning.js";
import type {
	ArtifactRepository,
	RoleAttempt,
	RoleAttemptRepository,
	SpecRepository,
	TaskMeta,
	TaskMetaRepository,
} from "../../modules/planning/ports.js";

const json = <T extends z.ZodType>(schema: T) =>
	z.string().transform((raw): z.infer<T> => schema.parse(JSON.parse(raw)));

const StringList = z.array(z.string());

const RequirementRow = z
	.object({
		id: z.string(),
		text: z.string(),
		acceptance: json(StringList),
		priority: z.string(),
		source_ref: z.string(),
	})
	.transform((row) =>
		RequirementSchema.parse({
			id: row.id,
			text: row.text,
			acceptance: row.acceptance,
			priority: row.priority,
			sourceRef: row.source_ref,
		}),
	);

const AssumptionRow = z
	.object({
		id: z.string(),
		statement: z.string(),
		reason: z.string(),
		impact: z.string(),
		reversible: z.number(),
		requirement_ids: json(StringList),
	})
	.transform((row) =>
		AssumptionSchema.parse({
			id: row.id,
			statement: row.statement,
			reason: row.reason,
			impact: row.impact,
			reversible: row.reversible === 1,
			requirementIds: row.requirement_ids,
		}),
	);

const ContradictionRow = z
	.object({
		id: z.string(),
		requirement_ids: json(StringList),
		description: z.string(),
		critical: z.number(),
	})
	.transform((row) =>
		ContradictionSchema.parse({
			id: row.id,
			requirementIds: row.requirement_ids,
			description: row.description,
			critical: row.critical === 1,
		}),
	);

const DecisionRow = z
	.object({
		id: z.string(),
		title: z.string(),
		context: z.string(),
		decision: z.string(),
		alternatives: json(StringList),
	})
	.transform((row) => DecisionSchema.parse(row));

export const createSpecRepository = (db: Database.Database): SpecRepository => {
	const latestVersion: SpecRepository["latestVersion"] = (runId) => {
		const row = db
			.prepare("SELECT MAX(spec_version) AS v FROM requirements WHERE run_id = ?")
			.get(runId);
		return z.object({ v: z.number().nullable() }).parse(row).v;
	};
	const count = (sql: string, ...params: unknown[]): number =>
		z.object({ n: z.number() }).parse(db.prepare(sql).get(...params)).n;

	return {
		latestVersion,
		insertSpec: (runId, version, spec) => {
			const insertReq = db.prepare(
				`INSERT INTO requirements (run_id, id, spec_version, text, acceptance, priority, source_ref)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			);
			for (const r of spec.requirements) {
				insertReq.run(
					runId,
					r.id,
					version,
					r.text,
					JSON.stringify(r.acceptance),
					r.priority,
					r.sourceRef,
				);
			}
			const insertAsm = db.prepare(
				`INSERT INTO assumptions (run_id, id, spec_version, statement, reason, impact, reversible, requirement_ids)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			for (const a of spec.assumptions) {
				insertAsm.run(
					runId,
					a.id,
					version,
					a.statement,
					a.reason,
					a.impact,
					a.reversible ? 1 : 0,
					JSON.stringify(a.requirementIds),
				);
			}
			const insertCon = db.prepare(
				`INSERT INTO contradictions (run_id, id, spec_version, requirement_ids, description, critical)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			);
			for (const c of spec.contradictions) {
				insertCon.run(
					runId,
					c.id,
					version,
					JSON.stringify(c.requirementIds),
					c.description,
					c.critical ? 1 : 0,
				);
			}
		},
		getSpec: (runId, version) => ({
			requirements: db
				.prepare("SELECT * FROM requirements WHERE run_id = ? AND spec_version = ? ORDER BY id")
				.all(runId, version)
				.map((row) => RequirementRow.parse(row)),
			assumptions: db
				.prepare("SELECT * FROM assumptions WHERE run_id = ? AND spec_version = ? ORDER BY id")
				.all(runId, version)
				.map((row) => AssumptionRow.parse(row)),
			contradictions: db
				.prepare("SELECT * FROM contradictions WHERE run_id = ? AND spec_version = ? ORDER BY id")
				.all(runId, version)
				.map((row) => ContradictionRow.parse(row)),
		}),
		summary: (runId) => {
			const specVersion = latestVersion(runId);
			if (specVersion === null) {
				return {
					specVersion,
					requirements: 0,
					assumptions: 0,
					contradictions: 0,
					criticalContradictions: 0,
				};
			}
			const of = (table: string, extra = ""): number =>
				count(
					`SELECT COUNT(*) AS n FROM ${table} WHERE run_id = ? AND spec_version = ? ${extra}`,
					runId,
					specVersion,
				);
			return {
				specVersion,
				requirements: of("requirements"),
				assumptions: of("assumptions"),
				contradictions: of("contradictions"),
				criticalContradictions: of("contradictions", "AND critical = 1"),
			};
		},
		insertDecisions: (runId, version, decisions) => {
			const insert = db.prepare(
				`INSERT INTO decisions (run_id, id, version, title, context, decision, alternatives)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			);
			for (const d of decisions) {
				insert.run(
					runId,
					d.id,
					version,
					d.title,
					d.context,
					d.decision,
					JSON.stringify(d.alternatives),
				);
			}
		},
		listDecisions: (runId, version) =>
			db
				.prepare("SELECT * FROM decisions WHERE run_id = ? AND version = ? ORDER BY id")
				.all(runId, version)
				.map((row) => DecisionRow.parse(row)),
	};
};

const ArtifactRow = z
	.object({
		id: z.string(),
		run_id: z.string(),
		kind: ArtifactKindSchema,
		subject: z.string(),
		version: z.number(),
		path: z.string(),
		sha256: z.string(),
		producer: z.string(),
		created_at: z.number(),
	})
	.transform(
		(row): Artifact => ({
			id: row.id,
			runId: row.run_id,
			kind: row.kind,
			subject: row.subject,
			version: row.version,
			path: row.path,
			sha256: row.sha256,
			producer: row.producer,
			createdAt: row.created_at,
		}),
	);

export const createArtifactRepository = (db: Database.Database): ArtifactRepository => ({
	insert: (a) => {
		db.prepare(
			`INSERT INTO artifacts (id, run_id, kind, subject, version, path, sha256, producer, created_at)
			 VALUES (@id, @runId, @kind, @subject, @version, @path, @sha256, @producer, @createdAt)`,
		).run(a);
	},
	find: (runId, kind, subject, version) => {
		const row = db
			.prepare(
				"SELECT * FROM artifacts WHERE run_id = ? AND kind = ? AND subject = ? AND version = ?",
			)
			.get(runId, kind, subject, version);
		return row === undefined ? undefined : ArtifactRow.parse(row);
	},
	latest: (runId, kind, subject) => {
		const row = db
			.prepare(
				"SELECT * FROM artifacts WHERE run_id = ? AND kind = ? AND subject = ? ORDER BY version DESC LIMIT 1",
			)
			.get(runId, kind, subject);
		return row === undefined ? undefined : ArtifactRow.parse(row);
	},
	list: (runId) =>
		db
			.prepare("SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at, rowid")
			.all(runId)
			.map((row) => ArtifactRow.parse(row)),
});

const AttemptOutcome = z.enum([
	"running",
	"accepted",
	"rejected_schema",
	"rejected_gate",
	"provider_failed",
]);

const RoleAttemptRow = z
	.object({
		id: z.number(),
		run_id: z.string(),
		role: RoleSchema,
		number: z.number(),
		repair: z.number(),
		model: z.string(),
		prompt_file: z.string(),
		prompt_hash: z.string(),
		outcome: AttemptOutcome,
		cost_usd: z.number().nullable(),
		error: z.string().nullable(),
		failure_class: z.string().nullable(),
		try_number: z.number(),
		started_at: z.number(),
		ended_at: z.number().nullable(),
	})
	.transform(
		(row): RoleAttempt => ({
			id: row.id,
			runId: row.run_id,
			role: row.role,
			number: row.number,
			repair: row.repair === 1,
			model: row.model,
			promptFile: row.prompt_file,
			promptHash: row.prompt_hash,
			outcome: row.outcome,
			costUsd: row.cost_usd,
			error: row.error,
			failureClass: row.failure_class,
			tryNumber: row.try_number,
			startedAt: row.started_at,
			endedAt: row.ended_at,
		}),
	);

export const createRoleAttemptRepository = (db: Database.Database): RoleAttemptRepository => ({
	start: ({ runId, role, repair, model, promptFile, promptHash, tryNumber, now }) => {
		const row = db
			.prepare(
				`INSERT INTO role_attempts (run_id, role, number, repair, model, prompt_file, prompt_hash, outcome, try_number, started_at)
				 VALUES (@runId, @role,
				   (SELECT COUNT(*) + 1 FROM role_attempts WHERE run_id = @runId AND role = @role),
				   @repair, @model, @promptFile, @promptHash, 'running', @tryNumber, @now)
				 RETURNING id`,
			)
			.get({
				runId,
				role,
				repair: repair ? 1 : 0,
				model,
				promptFile,
				promptHash,
				tryNumber: tryNumber ?? 1,
				now,
			});
		return z.object({ id: z.number() }).parse(row).id;
	},
	finish: (id, { outcome, costUsd, error, failureClass, now }) => {
		db.prepare(
			"UPDATE role_attempts SET outcome = ?, cost_usd = ?, error = ?, failure_class = ?, ended_at = ? WHERE id = ?",
		).run(outcome, costUsd, error, failureClass ?? null, now, id);
	},
	list: (runId) =>
		db
			.prepare("SELECT * FROM role_attempts WHERE run_id = ? ORDER BY id")
			.all(runId)
			.map((row) => RoleAttemptRow.parse(row)),
});

const TaskMetaRow = z
	.object({
		task_id: z.string(),
		run_id: z.string(),
		key: z.string(),
		requirement_ids: json(StringList),
		risk: RiskSchema,
		model_risk: RiskSchema,
		risk_reasons: json(StringList),
		expected_paths: json(StringList),
		blocked_reason: z.string().nullable(),
	})
	.transform(
		(row): TaskMeta => ({
			taskId: row.task_id,
			runId: row.run_id,
			key: row.key,
			requirementIds: row.requirement_ids,
			risk: row.risk,
			modelRisk: row.model_risk,
			riskReasons: row.risk_reasons,
			expectedPaths: row.expected_paths,
			blockedReason: row.blocked_reason,
		}),
	);

export const createTaskMetaRepository = (db: Database.Database): TaskMetaRepository => ({
	insertMany: (metas) => {
		const insert = db.prepare(
			`INSERT INTO task_meta (task_id, run_id, key, requirement_ids, risk, model_risk, risk_reasons, expected_paths, blocked_reason)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		for (const m of metas) {
			insert.run(
				m.taskId,
				m.runId,
				m.key,
				JSON.stringify(m.requirementIds),
				m.risk,
				m.modelRisk,
				JSON.stringify(m.riskReasons),
				JSON.stringify(m.expectedPaths),
				m.blockedReason,
			);
		}
	},
	listByRun: (runId) =>
		db
			.prepare("SELECT * FROM task_meta WHERE run_id = ? ORDER BY rowid")
			.all(runId)
			.map((row) => TaskMetaRow.parse(row)),
	getByTask: (taskId) => {
		const row = db.prepare("SELECT * FROM task_meta WHERE task_id = ?").get(taskId);
		return row === undefined ? undefined : TaskMetaRow.parse(row);
	},
});
