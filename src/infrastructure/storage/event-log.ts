import type Database from "better-sqlite3";
import { z } from "zod";
import { EventPayloadSchema, EventSchema, EventTypeSchema } from "../../contracts/events.js";
import type { EventLog } from "../../modules/runs/ports.js";

const EventRow = z
	.object({
		id: z.number(),
		run_id: z.string(),
		seq: z.number(),
		task_id: z.string().nullable(),
		type: EventTypeSchema,
		ts: z.number(),
		payload: z.string().transform((raw): unknown => JSON.parse(raw)),
	})
	.transform((row) =>
		EventSchema.parse({
			id: row.id,
			runId: row.run_id,
			seq: row.seq,
			taskId: row.task_id,
			type: row.type,
			timestamp: row.ts,
			payload: EventPayloadSchema.parse(row.payload),
		}),
	);

export const createEventLog = (db: Database.Database): EventLog => ({
	append: ({ runId, taskId, type, payload, now }) => {
		const row = db
			.prepare(
				`INSERT INTO events (run_id, seq, task_id, type, ts, payload)
				 VALUES (@runId, (SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE run_id = @runId),
				   @taskId, @type, @now, @payload)
				 RETURNING *`,
			)
			.get({
				runId,
				taskId: taskId ?? null,
				type,
				now,
				payload: JSON.stringify(EventPayloadSchema.parse(payload ?? {})),
			});
		return EventRow.parse(row);
	},
	list: (runId, { lastN }) => {
		const rows =
			lastN === undefined
				? db.prepare("SELECT * FROM events WHERE run_id = ? ORDER BY seq ASC").all(runId)
				: db
						.prepare(
							`SELECT * FROM (SELECT * FROM events WHERE run_id = ? ORDER BY seq DESC LIMIT ?)
							 ORDER BY seq ASC`,
						)
						.all(runId, lastN);
		return rows.map((row) => EventRow.parse(row));
	},
});
