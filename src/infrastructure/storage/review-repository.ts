import type Database from "better-sqlite3";
import { z } from "zod";
import {
	ConfidenceSchema,
	ReviewAreaSchema,
	ReviewerOutputSchema,
	SeveritySchema,
	VerdictSchema,
} from "../../contracts/review.js";
import type {
	RetryRepository,
	ReviewRepository,
	StoredFinding,
	StoredReview,
} from "../../modules/execution/ports.js";

const Json = <T extends z.ZodType>(schema: T) =>
	z.string().transform((raw) => schema.parse(JSON.parse(raw)) as z.infer<T>);

const Strings = Json(z.array(z.string()));

const AckList = Json(
	z.array(z.strictObject({ path: z.string(), decision: z.enum(["ok", "finding"]) })),
);

const ReviewRow = z
	.object({
		id: z.string(),
		run_id: z.string(),
		task_id: z.string(),
		cycle: z.number(),
		round: z.number(),
		area: ReviewAreaSchema,
		commit_sha: z.string(),
		spec_version: z.number(),
		verdict: VerdictSchema,
		reason: z.string().nullable(),
		carried: z.number(),
		acks: AckList,
		output: Json(ReviewerOutputSchema),
		artifact_id: z.string().nullable(),
		created_at: z.number(),
	})
	.transform(
		(row): StoredReview => ({
			id: row.id,
			runId: row.run_id,
			taskId: row.task_id,
			cycle: row.cycle,
			round: row.round,
			area: row.area,
			commitSha: row.commit_sha,
			specVersion: row.spec_version,
			verdict: row.verdict,
			reason: row.reason,
			acks: row.acks,
			output: row.output,
			artifactId: row.artifact_id,
			createdAt: row.created_at,
		}),
	);

const SourceList = Json(
	z.array(
		z.strictObject({
			area: ReviewAreaSchema,
			id: z.string(),
			evidence: z.string(),
			evidenceRef: z.string().optional(),
		}),
	),
);

const RefutationJson = Json(
	z.strictObject({
		outcome: z.enum(["confirmed", "refuted", "uncertain"]),
		evidence: z.string(),
	}),
);

const FindingRow = z
	.object({
		id: z.string(),
		run_id: z.string(),
		task_id: z.string(),
		cycle: z.number(),
		round: z.number(),
		commit_sha: z.string(),
		uid: z.string(),
		severity: SeveritySchema,
		confidence: ConfidenceSchema,
		title: z.string(),
		file: z.string().nullable(),
		line_start: z.number().nullable(),
		line_end: z.number().nullable(),
		impact: z.string(),
		recommendation: z.string(),
		requirement_ids: Strings,
		sources: SourceList,
		conflicts_with: Strings,
		status: z.enum(["open", "refuted"]),
		refutation: RefutationJson.nullable(),
		created_at: z.number(),
	})
	.transform(
		(row): StoredFinding => ({
			id: row.id,
			runId: row.run_id,
			taskId: row.task_id,
			cycle: row.cycle,
			round: row.round,
			commitSha: row.commit_sha,
			uid: row.uid,
			severity: row.severity,
			confidence: row.confidence,
			title: row.title,
			file: row.file,
			lineStart: row.line_start,
			lineEnd: row.line_end,
			impact: row.impact,
			recommendation: row.recommendation,
			requirementIds: row.requirement_ids,
			sources: row.sources,
			conflictsWith: row.conflicts_with,
			status: row.status,
			refutation: row.refutation,
			createdAt: row.created_at,
		}),
	);

export const createReviewRepository = (db: Database.Database): ReviewRepository => ({
	insertReview: (review) => {
		db.prepare(
			`INSERT INTO reviews (id, run_id, task_id, cycle, round, area, commit_sha, spec_version,
				verdict, reason, carried, acks, output, artifact_id, created_at)
			 VALUES (@id, @runId, @taskId, @cycle, @round, @area, @commitSha, @specVersion, @verdict,
				@reason, 0, @acks, @output, @artifactId, @createdAt)`,
		).run({
			...review,
			acks: JSON.stringify(review.acks),
			output: JSON.stringify(review.output),
		});
	},
	listReviews: (taskId, cycle) =>
		db
			.prepare("SELECT * FROM reviews WHERE task_id = ? AND cycle = ? ORDER BY created_at, rowid")
			.all(taskId, cycle)
			.map((row) => ReviewRow.parse(row)),
	replaceFindings: (input) => {
		db.prepare("DELETE FROM findings WHERE task_id = ? AND cycle = ? AND commit_sha = ?").run(
			input.taskId,
			input.cycle,
			input.commitSha,
		);
		const insert = db.prepare(
			`INSERT INTO findings (id, run_id, task_id, cycle, round, commit_sha, uid, severity,
				confidence, title, file, line_start, line_end, impact, recommendation, requirement_ids,
				sources, conflicts_with, status, refutation, created_at)
			 VALUES (@id, @runId, @taskId, @cycle, @round, @commitSha, @uid, @severity, @confidence,
				@title, @file, @lineStart, @lineEnd, @impact, @recommendation, @requirementIds,
				@sources, @conflictsWith, @status, @refutation, @createdAt)`,
		);
		for (const finding of input.findings) {
			insert.run({
				id: input.newId(),
				runId: input.runId,
				taskId: input.taskId,
				cycle: input.cycle,
				round: input.round,
				commitSha: input.commitSha,
				uid: finding.uid,
				severity: finding.severity,
				confidence: finding.confidence,
				title: finding.title,
				file: finding.file,
				lineStart: finding.lineStart,
				lineEnd: finding.lineEnd,
				impact: finding.impact,
				recommendation: finding.recommendation,
				requirementIds: JSON.stringify(finding.requirementIds),
				sources: JSON.stringify(finding.sources),
				conflictsWith: JSON.stringify(finding.conflictsWith),
				status: finding.status,
				refutation: finding.refutation === null ? null : JSON.stringify(finding.refutation),
				createdAt: input.now,
			});
		}
	},
	listFindings: (taskId, cycle, commitSha) =>
		db
			.prepare(
				`SELECT * FROM findings WHERE task_id = ? AND cycle = ? ${
					commitSha === undefined ? "" : "AND commit_sha = ?"
				} ORDER BY created_at, rowid`,
			)
			.all(...(commitSha === undefined ? [taskId, cycle] : [taskId, cycle, commitSha]))
			.map((row) => FindingRow.parse(row)),
	listFindingsByRun: (runId) =>
		db
			.prepare("SELECT * FROM findings WHERE run_id = ? ORDER BY created_at, rowid")
			.all(runId)
			.map((row) => FindingRow.parse(row)),
});

export const createRetryRepository = (db: Database.Database): RetryRepository => ({
	insert: (input) => {
		db.prepare(
			"INSERT INTO task_retries (run_id, task_id, reason, note, created_at) VALUES (?, ?, ?, ?, ?)",
		).run(input.runId, input.taskId, input.reason, input.note, input.now);
	},
	count: (taskId) => {
		const row = db
			.prepare("SELECT COUNT(*) AS n FROM task_retries WHERE task_id = ?")
			.get(taskId) as { n: number };
		return row.n;
	},
	latestNote: (taskId) => {
		const row = db
			.prepare("SELECT note FROM task_retries WHERE task_id = ? ORDER BY id DESC LIMIT 1")
			.get(taskId) as { note: string | null } | undefined;
		return row?.note ?? null;
	},
});
