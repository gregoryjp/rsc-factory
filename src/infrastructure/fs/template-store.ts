import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { TemplateManifestSchema } from "../../contracts/templates.js";
import type { TemplateFile, TemplateStore } from "../../modules/execution/ports.js";
import { fail, ok } from "../../shared/result.js";

const MANIFEST = "template.json";
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "coverage", ".npm-cache", ".git"]);
const TEMPLATE_ID = /^[a-z0-9][a-z0-9-]*$/;

const collect = (root: string, directory: string, found: TemplateFile[]): string | undefined => {
	for (const entry of readdirSync(directory).sort()) {
		const full = join(directory, entry);
		const stat = lstatSync(full);
		if (stat.isSymbolicLink()) return `Symbolic link in template: ${relative(root, full)}`;
		if (stat.isDirectory()) {
			if (SKIPPED_DIRECTORIES.has(entry)) continue;
			const problem = collect(root, full, found);
			if (problem !== undefined) return problem;
		} else if (stat.isFile()) {
			const path = relative(root, full).split(sep).join("/");
			if (path !== MANIFEST) found.push({ path, content: readFileSync(full) });
		}
	}
	return undefined;
};

export const createFsTemplateStore = (config: { repoRoot: string }): TemplateStore => ({
	load: (templateId) => {
		if (!TEMPLATE_ID.test(templateId)) {
			return fail("template_not_found", `Invalid template id: ${JSON.stringify(templateId)}`);
		}
		const root = join(config.repoRoot, "factory", "templates", templateId);
		let manifestRaw: string;
		try {
			manifestRaw = readFileSync(join(root, MANIFEST), "utf8");
		} catch {
			return fail("template_not_found", `Template ${templateId} has no ${MANIFEST}`);
		}
		let manifestJson: unknown;
		try {
			manifestJson = JSON.parse(manifestRaw);
		} catch {
			return fail("template_invalid", `Template ${templateId}: ${MANIFEST} is not valid JSON`);
		}
		const manifest = TemplateManifestSchema.safeParse(manifestJson);
		if (!manifest.success || manifest.data.id !== templateId) {
			return fail("template_invalid", `Template ${templateId}: invalid ${MANIFEST}`);
		}
		const files: TemplateFile[] = [];
		const problem = collect(root, root, files);
		if (problem !== undefined) return fail("template_invalid", problem);
		const paths = new Set(files.map((file) => file.path));
		const missing = manifest.data.render.filter((path) => !paths.has(path));
		if (missing.length > 0) {
			return fail(
				"template_invalid",
				`Template ${templateId}: render files missing: ${missing.join(", ")}`,
			);
		}
		return ok({ manifest: manifest.data, files });
	},
});
