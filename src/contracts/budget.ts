import { z } from "zod";
import { RoleSchema } from "./planning.js";

export const DEFAULT_MAX_CODEX_CALLS_PER_RUN = 12;

const PositiveUsd = z.number().positive().finite();

export const BudgetConfigSchema = z.strictObject({
	defaultRunBudgetUsd: PositiveUsd,
	maxCallUsd: z.strictObject(
		Object.fromEntries(RoleSchema.options.map((role) => [role, PositiveUsd])) as Record<
			(typeof RoleSchema.options)[number],
			typeof PositiveUsd
		>,
	),
	maxCodexCallsPerRun: z.number().int().positive().default(DEFAULT_MAX_CODEX_CALLS_PER_RUN),
	retry: z.strictObject({
		maxAttempts: z.number().int().min(1).max(10),
		baseMs: z.number().int().positive(),
		capMs: z.number().int().positive(),
	}),
});
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;

export const BUDGET_CONFIG_PATH = "factory/config/budget.json";

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
	defaultRunBudgetUsd: 15,
	maxCallUsd: {
		"spec-writer": 0.3,
		architect: 0.3,
		planner: 0.3,
		builder: 1.5,
		"reviewer-security": 0.5,
		"reviewer-code": 0.5,
		"reviewer-ux": 0.5,
		"reviewer-ui": 0.5,
		"reviewer-legal": 0.5,
		"review-refuter": 0.5,
		approver: 0.2,
	},
	maxCodexCallsPerRun: DEFAULT_MAX_CODEX_CALLS_PER_RUN,
	retry: { maxAttempts: 3, baseMs: 2000, capMs: 60_000 },
};

export type BudgetBasis = "reservation" | "reported" | "unknown_reservation";
export type BudgetEntryKind = "reservation" | "charge" | "release";
