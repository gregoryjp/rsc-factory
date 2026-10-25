import { type RolesConfig, RolesConfigSchema } from "../../contracts/planning.js";
import { type Failure, fail, ok, type Result } from "../../shared/result.js";
import type { FactoryFiles } from "./ports.js";

export const ROLES_CONFIG_PATH = "factory/config/roles.json";

export const loadRolesConfig = (files: FactoryFiles): Result<RolesConfig, Failure<string>> => {
	const config = files.read(ROLES_CONFIG_PATH);
	if (!config.ok) return fail("role_assets_unavailable", config.error.message);
	const parsed = (() => {
		try {
			return RolesConfigSchema.safeParse(JSON.parse(config.value.content));
		} catch {
			return undefined;
		}
	})();
	return parsed?.success
		? ok(parsed.data)
		: fail("role_assets_unavailable", `${ROLES_CONFIG_PATH} is not a valid roles config`);
};
