import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BudgetConfigSchema, DEFAULT_BUDGET_CONFIG } from "../src/contracts/budget.js";
import { RoleSchema } from "../src/contracts/planning.js";
import { reconcileStaleReservations } from "../src/modules/budget/reconcile.js";
import { startRun } from "../src/modules/runs/start-run.js";
import { createEnv, makeTempDir, REPO_ROOT, writePrd } from "./helpers/env.js";

const seed = (budgetUsd?: number) => {
	const env = createEnv();
	const dir = makeTempDir();
	const started = startRun(env, {
		prdPath: writePrd(dir),
		targetPath: join(makeTempDir(), "product"),
		projectName: "budget-demo",
		cwd: dir,
		forceNew: false,
		deliveryTarget: null,
		...(budgetUsd === undefined ? {} : { budgetUsd }),
	});
	if (!started.ok) throw new Error(started.error.message);
	return { env, runId: started.value.run.id };
};

describe("budget config", () => {
	it("ships a valid factory/config/budget.json with a ceiling for every role", async () => {
		const { readFileSync } = await import("node:fs");
		const raw: unknown = JSON.parse(
			readFileSync(join(REPO_ROOT, "factory", "config", "budget.json"), "utf8"),
		);
		const parsed = BudgetConfigSchema.parse(raw);
		for (const role of RoleSchema.options) expect(parsed.maxCallUsd[role]).toBeGreaterThan(0);
		expect(parsed).toEqual(DEFAULT_BUDGET_CONFIG);
	});

	it("rejects missing roles and non-positive values", () => {
		expect(BudgetConfigSchema.safeParse({ ...DEFAULT_BUDGET_CONFIG, maxCallUsd: {} }).success).toBe(
			false,
		);
		expect(
			BudgetConfigSchema.safeParse({ ...DEFAULT_BUDGET_CONFIG, defaultRunBudgetUsd: 0 }).success,
		).toBe(false);
	});
});

describe("budget ledger (migration 7)", () => {
	it("applies migration 7 and gives new runs the requested or default budget", () => {
		expect(seed().env.storage.appliedMigrations()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		const a = seed();
		expect(a.env.storage.budgets.limit(a.runId)).toBe(15);
		const b = seed(4.5);
		expect(b.env.storage.budgets.limit(b.runId)).toBe(4.5);
	});

	it("reserves atomically against the remaining budget and refuses beyond it", () => {
		const { env, runId } = seed(5);
		const { budgets } = env.storage;
		const first = budgets.reserve({ runId, role: "builder", amountUsd: 3, now: 1 });
		expect(first.ok).toBe(true);
		const second = budgets.reserve({ runId, role: "builder", amountUsd: 3, now: 2 });
		expect(second).toMatchObject({ ok: false, error: { remainingUsd: 2 } });
		expect(budgets.summary(runId)).toMatchObject({
			budgetUsd: 5,
			reservedUsd: 3,
			remainingUsd: 2,
			chargedReportedUsd: 0,
		});
	});

	it("charges the reported cost, releases the rest and frees remaining budget", () => {
		const { env, runId } = seed(5);
		const { budgets } = env.storage;
		const reservation = budgets.reserve({ runId, role: "planner", amountUsd: 3, now: 1 });
		if (!reservation.ok) throw new Error("reserve failed");
		budgets.settle({
			reservationId: reservation.value,
			chargeUsd: 0.4,
			basis: "reported",
			now: 2,
		});
		expect(budgets.summary(runId)).toMatchObject({
			chargedReportedUsd: 0.4,
			chargedUnknownUsd: 0,
			reservedUsd: 0,
			remainingUsd: 4.6,
		});
		expect(budgets.entries(runId).map((e) => [e.kind, e.amountUsd, e.basis])).toEqual([
			["reservation", 3, "reservation"],
			["charge", 0.4, "reported"],
			["release", 2.6, "reported"],
		]);
	});

	it("charges the full reservation as unknown when the cost is not reported", () => {
		const { env, runId } = seed(5);
		const { budgets } = env.storage;
		const reservation = budgets.reserve({ runId, role: "builder", amountUsd: 3, now: 1 });
		if (!reservation.ok) throw new Error("reserve failed");
		budgets.settle({
			reservationId: reservation.value,
			chargeUsd: 3,
			basis: "unknown_reservation",
			now: 2,
		});
		expect(budgets.summary(runId)).toMatchObject({
			chargedReportedUsd: 0,
			chargedUnknownUsd: 3,
			remainingUsd: 2,
		});
	});

	it("settles a reservation at most once", () => {
		const { env, runId } = seed(5);
		const { budgets } = env.storage;
		const reservation = budgets.reserve({ runId, role: "builder", amountUsd: 3, now: 1 });
		if (!reservation.ok) throw new Error("reserve failed");
		const input = {
			reservationId: reservation.value,
			chargeUsd: 1,
			basis: "reported" as const,
			now: 2,
		};
		budgets.settle(input);
		budgets.settle(input);
		expect(budgets.summary(runId).chargedReportedUsd).toBe(1);
	});

	it("charges reservations left open past the staleness window as unknown and logs them", () => {
		const { env, runId } = seed(10);
		const { budgets } = env.storage;
		const lost = budgets.reserve({ runId, role: "builder", amountUsd: 3, now: 1_000 });
		const fresh = budgets.reserve({ runId, role: "planner", amountUsd: 2, now: 50_000_000 });
		expect(lost.ok && fresh.ok).toBe(true);
		const swept = reconcileStaleReservations(env, {
			runId,
			staleAfterMs: 45 * 60 * 1000,
			now: 50_000_000,
		});
		expect(swept).toBe(1);
		expect(budgets.summary(runId)).toMatchObject({
			chargedUnknownUsd: 3,
			reservedUsd: 2,
			remainingUsd: 5,
		});
		const logged = env.storage.events
			.list(runId, {})
			.filter((e) => e.type === "budget.reservation_expired");
		expect(logged).toHaveLength(1);
		expect(logged[0]?.payload).toMatchObject({ role: "builder", amountUsd: 3 });
		expect(
			reconcileStaleReservations(env, { runId, staleAfterMs: 45 * 60 * 1000, now: 50_000_000 }),
		).toBe(0);
	});

	it("adds budget to a run", () => {
		const { env, runId } = seed(5);
		env.storage.budgets.setLimit(runId, 9);
		expect(env.storage.budgets.limit(runId)).toBe(9);
	});
});
