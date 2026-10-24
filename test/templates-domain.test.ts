import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TemplateManifestSchema } from "../src/contracts/templates.js";
import {
	renderPlaceholders,
	selectTemplateId,
	toProductName,
	toProductSlug,
} from "../src/domain/templates/render.js";
import { createFsTemplateStore } from "../src/infrastructure/fs/template-store.js";
import { REPO_ROOT } from "./helpers/env.js";

describe("renderPlaceholders", () => {
	const values = { productName: "Turno Local", productSlug: "turno-local" };

	it("replaces every occurrence of the two known placeholders", () => {
		expect(
			renderPlaceholders("{{PRODUCT_NAME}} / {{PRODUCT_SLUG}} / {{PRODUCT_NAME}}", values),
		).toBe("Turno Local / turno-local / Turno Local");
	});

	it("leaves unknown placeholders and similar text untouched", () => {
		const text = ["{{OTHER}}", "$", "{PRODUCT_NAME}", "{{ PRODUCT_NAME }}"].join(" ");
		expect(renderPlaceholders(text, values)).toBe(text);
	});

	it("does not re-expand placeholders contained in values", () => {
		expect(
			renderPlaceholders("{{PRODUCT_NAME}}", { productName: "{{PRODUCT_SLUG}}", productSlug: "x" }),
		).toBe("{{PRODUCT_SLUG}}");
	});

	it("is pure for content without placeholders", () => {
		expect(renderPlaceholders("plain", values)).toBe("plain");
	});
});

describe("product name and slug", () => {
	it("keeps letters, digits, spaces, dots, dashes and underscores", () => {
		expect(toProductName("Turno Local v2_beta.1")).toBe("Turno Local v2_beta.1");
	});

	it("strips characters that could break generated code", () => {
		expect(toProductName(`Tu"rno\\ <Local>\n\`x\``)).toBe("Turno Local x");
	});

	it("falls back to a default for empty input", () => {
		expect(toProductName("   ")).toBe("Product");
		expect(toProductSlug("???")).toBe("product");
	});

	it("derives an ascii slug usable as a database name prefix", () => {
		expect(toProductSlug("Turno Local")).toBe("turno_local");
		expect(toProductSlug("Café ñandú 2")).toBe("cafe_nandu_2");
		expect(toProductSlug("9 lives")).toBe("p_9_lives");
	});

	it("bounds the slug length", () => {
		expect(toProductSlug("a".repeat(100)).length).toBeLessThanOrEqual(40);
	});
});

describe("selectTemplateId", () => {
	it("maps backend + web to fullstack-kimmbo regardless of order", () => {
		for (const ids of [
			["backend-express-kimmbo", "web-react-vite"],
			["web-react-vite", "backend-express-kimmbo"],
		]) {
			expect(selectTemplateId(ids)).toEqual({ ok: true, value: "fullstack-kimmbo" });
		}
	});

	it("maps static-landing to static-landing", () => {
		expect(selectTemplateId(["static-landing"])).toEqual({ ok: true, value: "static-landing" });
	});

	it.each([
		[["backend-express-kimmbo"]],
		[["web-react-vite"]],
		[["static-landing", "web-react-vite"]],
		[[]],
		[["unknown"]],
	])("rejects unsupported preset combination %j", (ids) => {
		expect(selectTemplateId(ids)).toMatchObject({
			ok: false,
			error: { code: "no_template_for_presets" },
		});
	});
});

describe("template manifests on disk", () => {
	it.each(["fullstack-kimmbo", "static-landing"])(
		"%s manifest matches the selection table",
		(id) => {
			const raw = readFileSync(
				join(REPO_ROOT, "factory", "templates", id, "template.json"),
				"utf8",
			);
			const manifest = TemplateManifestSchema.parse(JSON.parse(raw));
			expect(manifest.id).toBe(id);
			expect(selectTemplateId(manifest.presetIds)).toEqual({ ok: true, value: id });
		},
	);
});

describe("template store", () => {
	const store = createFsTemplateStore({ repoRoot: REPO_ROOT });

	it.each(["fullstack-kimmbo", "static-landing"])(
		"%s lists every file with a placeholder in its render list and ships a lockfile",
		(id) => {
			const loaded = store.load(id);
			if (!loaded.ok) throw new Error(loaded.error.message);
			const render = new Set(loaded.value.manifest.render);
			for (const file of loaded.value.files) {
				const hasPlaceholder = /\{\{PRODUCT_(NAME|SLUG)\}\}/.test(file.content.toString("utf8"));
				expect(hasPlaceholder, file.path).toBe(render.has(file.path));
			}
			const paths = loaded.value.files.map((file) => file.path);
			expect(paths).toContain("package-lock.json");
			expect(paths).not.toContain("template.json");
			expect(paths.some((path) => path.includes("node_modules"))).toBe(false);
		},
	);

	it("rejects unknown and malformed template ids", () => {
		expect(store.load("nope")).toMatchObject({ ok: false, error: { code: "template_not_found" } });
		expect(store.load("../fullstack-kimmbo")).toMatchObject({
			ok: false,
			error: { code: "template_not_found" },
		});
	});
});
