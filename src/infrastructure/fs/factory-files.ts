import { readFileSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import type { FactoryFiles } from "../../modules/planning/ports.js";
import { sha256Of } from "../../shared/hash.js";
import { fail, ok } from "../../shared/result.js";

export const createFsFactoryFiles = (config: { repoRoot: string }): FactoryFiles => ({
	read: (relativePath) => {
		const normalized = normalize(relativePath);
		if (isAbsolute(normalized) || normalized === ".." || normalized.startsWith(`..${sep}`)) {
			return fail("factory_file_unreadable", `Unsafe factory file path: ${relativePath}`);
		}
		try {
			const content = readFileSync(join(config.repoRoot, normalized), "utf8");
			return ok({ content, sha256: sha256Of(content) });
		} catch (cause) {
			const reason = cause instanceof Error ? cause.message : "unknown error";
			return fail("factory_file_unreadable", `Could not read ${relativePath}: ${reason}`);
		}
	},
});
