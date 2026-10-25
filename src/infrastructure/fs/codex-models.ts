import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { type Failure, fail, ok, type Result } from "../../shared/result.js";

const MODELS_CACHE_FILE = "models_cache.json";

const CacheSchema = z.object({ models: z.array(z.object({ slug: z.string() })) });

export const readCodexModelSlugs = (codexHome: string): Result<string[], Failure<string>> => {
	try {
		const parsed = CacheSchema.safeParse(
			JSON.parse(readFileSync(join(codexHome, MODELS_CACHE_FILE), "utf8")),
		);
		return parsed.success
			? ok(parsed.data.models.map((model) => model.slug))
			: fail("codex_models_unreadable", `${MODELS_CACHE_FILE} has an unexpected shape`);
	} catch {
		return fail("codex_models_unreadable", `${MODELS_CACHE_FILE} not found or unreadable`);
	}
};
