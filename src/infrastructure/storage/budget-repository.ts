import type Database from "better-sqlite3";
import { z } from "zod";
import type { BudgetBasis, BudgetEntryKind } from "../../contracts/budget.js";
import type {
	BudgetEntry,
	BudgetRepository,
	BudgetSummary,
	OpenReservation,
} from "../../modules/budget/ports.js";
import { err, ok } from "../../shared/result.js";

const EPSILON = 1e-9;
const CENTS = 1e6;

const round = (value: number): number => Math.round(value * CENTS) / CENTS;

const EntryRow = z
	.object({
		id: z.number(),
		run_id: z.string(),
		kind: z.enum(["reservation", "charge", "release"]),
		role: z.string(),
		attempt_id: z.number().nullable(),
		reservation_id: z.number().nullable(),
		amount_usd: z.number(),
		basis: z.enum(["reservation", "reported", "unknown_reservation"]),
		created_at: z.number(),
	})
	.transform(
		(row): BudgetEntry => ({
			id: row.id,
			runId: row.run_id,
			kind: row.kind satisfies BudgetEntryKind,
			role: row.role,
			attemptId: row.attempt_id,
			reservationId: row.reservation_id,
			amountUsd: row.amount_usd,
			basis: row.basis satisfies BudgetBasis,
			createdAt: row.created_at,
		}),
	);

const OpenRow = z.object({
	id: z.number(),
	role: z.string(),
	amount_usd: z.number(),
	attempt_id: z.number().nullable(),
	created_at: z.number(),
});

const Total = z.object({ total: z.number() });
const CallRow = z.object({ role: z.string(), calls: z.number() });
const Count = z.object({ n: z.number() });

const OPEN_RESERVATIONS = `
	SELECT r.* FROM budget_entries r
	WHERE r.run_id = @runId AND r.kind = 'reservation'
	  AND NOT EXISTS (SELECT 1 FROM budget_entries c WHERE c.reservation_id = r.id AND c.kind = 'charge')`;

export const createBudgetRepository = (db: Database.Database): BudgetRepository => {
	const total = (sql: string, params: Record<string, unknown>): number =>
		Total.parse(db.prepare(sql).get(params)).total;

	const limit: BudgetRepository["limit"] = (runId) =>
		z
			.object({ budget_usd: z.number() })
			.parse(db.prepare("SELECT budget_usd FROM runs WHERE id = ?").get(runId)).budget_usd;

	const charged = (runId: string, basis: BudgetBasis): number =>
		total(
			"SELECT COALESCE(SUM(amount_usd), 0) AS total FROM budget_entries WHERE run_id = @runId AND kind = 'charge' AND basis = @basis",
			{ runId, basis },
		);

	const reserved = (runId: string): number =>
		total(`SELECT COALESCE(SUM(amount_usd), 0) AS total FROM (${OPEN_RESERVATIONS})`, { runId });

	const remaining = (runId: string): number =>
		limit(runId) -
		charged(runId, "reported") -
		charged(runId, "unknown_reservation") -
		reserved(runId);

	const insertEntry = db.prepare(
		`INSERT INTO budget_entries (run_id, kind, role, attempt_id, reservation_id, amount_usd, basis, created_at)
		 VALUES (@runId, @kind, @role, @attemptId, @reservationId, @amountUsd, @basis, @createdAt)`,
	);

	const reserve = db.transaction(
		(input: { runId: string; role: string; amountUsd: number; now: number }) => {
			const left = remaining(input.runId);
			if (left + EPSILON < input.amountUsd) {
				return err({
					code: "budget_exhausted" as const,
					message: `Run budget exhausted: ${round(left)} USD remaining, ${input.amountUsd} USD needed for ${input.role}`,
					remainingUsd: round(left),
				});
			}
			const info = insertEntry.run({
				runId: input.runId,
				kind: "reservation",
				role: input.role,
				attemptId: null,
				reservationId: null,
				amountUsd: input.amountUsd,
				basis: "reservation",
				createdAt: input.now,
			});
			return ok(Number(info.lastInsertRowid));
		},
	);

	const settle = db.transaction(
		(input: {
			reservationId: number;
			chargeUsd: number;
			basis: "reported" | "unknown_reservation";
			now: number;
		}) => {
			const row = db
				.prepare("SELECT * FROM budget_entries WHERE id = ? AND kind = 'reservation'")
				.get(input.reservationId);
			if (row === undefined) return;
			const reservation = EntryRow.parse(row);
			const already = Count.parse(
				db
					.prepare(
						"SELECT COUNT(*) AS n FROM budget_entries WHERE reservation_id = ? AND kind = 'charge'",
					)
					.get(input.reservationId),
			).n;
			if (already > 0) return;
			const common = {
				runId: reservation.runId,
				role: reservation.role,
				attemptId: reservation.attemptId,
				reservationId: reservation.id,
				basis: input.basis,
				createdAt: input.now,
			};
			insertEntry.run({ ...common, kind: "charge", amountUsd: input.chargeUsd });
			const released = round(reservation.amountUsd - input.chargeUsd);
			if (released > 0) insertEntry.run({ ...common, kind: "release", amountUsd: released });
		},
	);

	return {
		limit,
		setLimit: (runId, budgetUsd) => {
			db.prepare("UPDATE runs SET budget_usd = ? WHERE id = ?").run(budgetUsd, runId);
		},
		reserve: (input) => reserve(input),
		attach: (reservationId, attemptId) => {
			db.prepare("UPDATE budget_entries SET attempt_id = ? WHERE id = ?").run(
				attemptId,
				reservationId,
			);
		},
		settle: (input) => settle(input),
		providerCalls: (runId, provider) =>
			Count.parse(
				db
					.prepare(
						"SELECT COUNT(*) AS n FROM role_attempts WHERE run_id = ? AND provider = ? AND COALESCE(failure_class, '') != 'budget_exhausted'",
					)
					.get(runId, provider),
			).n,
		openReservations: (runId): OpenReservation[] =>
			db
				.prepare(`${OPEN_RESERVATIONS} ORDER BY r.id`)
				.all({ runId })
				.map((row) => {
					const parsed = OpenRow.parse(row);
					return {
						id: parsed.id,
						role: parsed.role,
						amountUsd: parsed.amount_usd,
						attemptId: parsed.attempt_id,
						createdAt: parsed.created_at,
					};
				}),
		entries: (runId) =>
			db
				.prepare("SELECT * FROM budget_entries WHERE run_id = ? ORDER BY id")
				.all(runId)
				.map((row) => EntryRow.parse(row)),
		summary: (runId): BudgetSummary => {
			const calls: Record<string, number> = {};
			for (const row of db
				.prepare(
					"SELECT role, COUNT(*) AS calls FROM role_attempts WHERE run_id = ? AND COALESCE(failure_class, '') != 'budget_exhausted' GROUP BY role",
				)
				.all(runId)) {
				const parsed = CallRow.parse(row);
				calls[parsed.role] = parsed.calls;
			}
			const retries = Count.parse(
				db
					.prepare("SELECT COUNT(*) AS n FROM role_attempts WHERE run_id = ? AND try_number > 1")
					.get(runId),
			).n;
			return {
				budgetUsd: limit(runId),
				chargedReportedUsd: round(charged(runId, "reported")),
				chargedUnknownUsd: round(charged(runId, "unknown_reservation")),
				reservedUsd: round(reserved(runId)),
				remainingUsd: round(remaining(runId)),
				callsByRole: calls,
				retries,
			};
		},
	};
};
