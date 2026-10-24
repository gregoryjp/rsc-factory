import {
	BUDGET_CONFIG_PATH,
	type BudgetConfig,
	BudgetConfigSchema,
	DEFAULT_BUDGET_CONFIG,
} from "../../contracts/budget.js";
import { type Failure, fail, ok, type Result } from "../../shared/result.js";
import type { FactoryFiles } from "../planning/ports.js";

export const loadBudgetConfig = (files: FactoryFiles): Result<BudgetConfig, Failure<string>> => {
	const read = files.read(BUDGET_CONFIG_PATH);
	if (!read.ok) return ok(DEFAULT_BUDGET_CONFIG);
	try {
		const parsed = BudgetConfigSchema.safeParse(JSON.parse(read.value.content));
		return parsed.success
			? ok(parsed.data)
			: fail("budget_config_invalid", `${BUDGET_CONFIG_PATH}: ${parsed.error.message}`);
	} catch {
		return fail("budget_config_invalid", `${BUDGET_CONFIG_PATH} is not valid JSON`);
	}
};
