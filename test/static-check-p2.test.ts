import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir, REPO_ROOT } from "./helpers/env.js";

const LANDING = join(REPO_ROOT, "factory", "templates", "landing");
const WEB = join(REPO_ROOT, "factory", "templates", "apiweb", "web");

const copy = (from: string): string => {
	const root = makeTempDir();
	spawnSync("cp", ["-R", `${from}/.`, root]);
	return root;
};

const put = (root: string, files: Record<string, string | Buffer>): void => {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
};

const check = (script: string, root: string) => {
	const run = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
	return { code: run.status, out: `${run.stdout}${run.stderr}` };
};

const landingCheck = (root: string) => check(join(LANDING, "scripts", "check.mjs"), root);

const withBody = (root: string, body: string): void => {
	const index = readFileSync(join(root, "index.html"), "utf8");
	put(root, { "index.html": index.replace("</main>", `${body}</main>`) });
};

const expectFail = (result: { code: number | null; out: string }, needle: string): void => {
	expect(result.code).toBe(1);
	expect(result.out).toContain(needle);
};

describe("landing check: performance budget", () => {
	it("passes the shipped template", () => {
		expect(landingCheck(LANDING).code).toBe(0);
	});

	it("fails when the stylesheets or scripts exceed the byte budget", () => {
		const css = copy(LANDING);
		put(css, { "big.css": `.a{content:"${"x".repeat(70 * 1024)}"}` });
		expectFail(landingCheck(css), "performance budget: CSS");
		const js = copy(LANDING);
		put(js, { "app.js": `export const a = "${"x".repeat(40 * 1024)}";` });
		expectFail(landingCheck(js), "performance budget: JS");
	});

	it("fails on oversized images and legacy raster formats", () => {
		const huge = copy(LANDING);
		put(huge, { "img/hero.webp": randomBytes(320 * 1024) });
		expectFail(landingCheck(huge), "is larger than 300 KiB");
		const legacy = copy(LANDING);
		put(legacy, { "img/hero.png": randomBytes(120 * 1024) });
		expectFail(landingCheck(legacy), "use webp or avif");
		const small = copy(LANDING);
		put(small, { "img/icon.png": randomBytes(4 * 1024) });
		expect(landingCheck(small).code).toBe(0);
	});

	it("requires width, height and loading on images", () => {
		const bad = copy(LANDING);
		withBody(bad, '<img src="logo.svg" alt="Logo">');
		put(bad, { "logo.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>" });
		const result = landingCheck(bad);
		expectFail(result, "<img> needs width and height");
		expect(result.out).toContain('<img> needs loading="lazy" or loading="eager"');
		const good = copy(LANDING);
		withBody(good, '<img src="logo.svg" alt="Logo" width="32" height="32" loading="lazy">');
		put(good, { "logo.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>" });
		expect(landingCheck(good).code).toBe(0);
	});

	it("requires font-display on @font-face and local font files", () => {
		const bad = copy(LANDING);
		put(bad, { "fonts.css": '@font-face{font-family:X;src:url("x.woff2")}' });
		expectFail(landingCheck(bad), "@font-face needs font-display");
		const good = copy(LANDING);
		put(good, { "fonts.css": '@font-face{font-family:X;src:url("x.woff2");font-display:swap}' });
		expect(landingCheck(good).code).toBe(0);
		const remote = copy(LANDING);
		put(remote, {
			"fonts.css": '@font-face{font-family:X;src:url("https://f.e.com/x.woff2");font-display:swap}',
		});
		expectFail(landingCheck(remote), "@font-face must load fonts from the same origin");
	});
});

describe("landing check: WCAG 2.2 static rules", () => {
	it("fails on skipped heading levels and on several h1", () => {
		const skip = copy(LANDING);
		withBody(skip, "<h3>Skip</h3>");
		expectFail(landingCheck(skip), "heading level jumps from h1 to h3");
		const two = copy(LANDING);
		withBody(two, "<h1>Other</h1>");
		expectFail(landingCheck(two), "exactly one <h1>");
	});

	it("requires a label for every form control", () => {
		const bad = copy(LANDING);
		withBody(bad, '<form><input type="text" name="n"></form>');
		expectFail(landingCheck(bad), "form control without an accessible label");
		const good = copy(LANDING);
		withBody(
			good,
			'<form><label for="n">Nombre</label><input id="n" type="text" name="n"><input type="hidden" name="h"><input type="email" aria-label="Correo" name="e"><label>Tel <input type="tel" name="t"></label><button type="submit">Enviar</button></form>',
		);
		expect(landingCheck(good).code).toBe(0);
	});

	it.each([
		["a positive tabindex", '<a href="#main" tabindex="2">x</a>', "positive tabindex"],
		[
			"aria-hidden on a focusable element",
			'<a href="#main" aria-hidden="true">x</a>',
			"aria-hidden",
		],
		["role=button without tabindex", '<div role="button">x</div>', 'role="button"'],
		["an image without alt", '<img src="a.svg" width="1" height="1" loading="lazy">', "alt"],
		["an empty link", '<a href="#main"></a>', "link without an accessible name"],
		["an unknown ARIA role", '<div role="buton">x</div>', "unknown ARIA role"],
	])("fails on %s", (_name, body, needle) => {
		const root = copy(LANDING);
		put(root, { "a.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>" });
		withBody(root, body);
		expectFail(landingCheck(root), needle);
	});

	it("fails when focus outlines are removed or reduced motion does not neutralize motion", () => {
		const outline = copy(LANDING);
		put(outline, { "extra.css": "button{outline:none}" });
		expectFail(landingCheck(outline), "removes the focus outline");
		const safe = copy(LANDING);
		put(safe, { "extra.css": "button:focus:not(:focus-visible){outline:none}" });
		expect(landingCheck(safe).code).toBe(0);
		const motion = copy(LANDING);
		put(motion, {
			"styles.css": `${readFileSync(join(LANDING, "styles.css"), "utf8").replace(/@media \(prefers-reduced-motion[\s\S]*$/, "@media (prefers-reduced-motion: reduce){a{color:red}}")}`,
		});
		expectFail(landingCheck(motion), "prefers-reduced-motion must neutralize");
	});
});

describe("landing check: string table", () => {
	const shipped = JSON.parse(readFileSync(join(LANDING, "i18n", "es.json"), "utf8")) as Record<
		string,
		string
	>;
	const table = (entries: Record<string, string>) => ({
		"i18n/es.json": JSON.stringify({ ...shipped, ...entries }),
	});

	it("accepts data-i18n text that matches the table for the page language", () => {
		const root = copy(LANDING);
		put(root, table({ "home.note": "Hola" }));
		withBody(root, '<p data-i18n="home.note">Hola</p>');
		expect(landingCheck(root).code).toBe(0);
	});

	it("fails on drifting text, missing keys and a missing table", () => {
		const drift = copy(LANDING);
		put(drift, table({ "home.note": "Adiós" }));
		withBody(drift, '<p data-i18n="home.note">Hola</p>');
		expectFail(landingCheck(drift), 'data-i18n "home.note" text differs from i18n/es.json');
		const missing = copy(LANDING);
		put(missing, table({}));
		withBody(missing, '<p data-i18n="home.note">Hola</p>');
		expectFail(landingCheck(missing), 'data-i18n key "home.note" is not in i18n/es.json');
		const none = copy(LANDING);
		rmSync(join(none, "i18n"), { recursive: true });
		withBody(none, '<p data-i18n="home.note">Hola</p>');
		expectFail(landingCheck(none), "i18n/es.json does not exist");
	});

	it("ships the string table with the landing copy and keeps it in sync", () => {
		const entries = JSON.parse(readFileSync(join(LANDING, "i18n", "es.json"), "utf8")) as Record<
			string,
			string
		>;
		expect(Object.keys(entries).length).toBeGreaterThan(2);
		expect(readFileSync(join(LANDING, "index.html"), "utf8")).toContain("data-i18n=");
	});
});

describe("web check: build budget and design system", () => {
	const webCheck = (root: string) => check(join(WEB, "scripts", "check-static.mjs"), root);

	it("passes the shipped web template", () => {
		expect(webCheck(WEB).code).toBe(0);
	});

	it("fails when the built JS or CSS exceeds the gzip budget", () => {
		const js = copy(WEB);
		put(js, { "dist/assets/index-abc.js": randomBytes(260 * 1024) });
		expectFail(webCheck(js), "performance budget: JS");
		const css = copy(WEB);
		put(css, { "dist/assets/index-abc.css": randomBytes(60 * 1024) });
		expectFail(webCheck(css), "performance budget: CSS");
		const ok = copy(WEB);
		put(ok, { "dist/assets/index-abc.js": "export const a = 1;\n" });
		expect(webCheck(ok).code).toBe(0);
	});

	it("fails on a form control without a label in a component", () => {
		const root = copy(WEB);
		put(root, { "src/Form.tsx": "export const F = () => <input type='text' name='a' />;\n" });
		expectFail(webCheck(root), "form control without an accessible label");
	});

	it("ships the i18n message table with a typed t() and a test", () => {
		const messages = readFileSync(join(WEB, "src", "i18n", "messages.ts"), "utf8");
		expect(messages).toContain("as const");
		expect(readFileSync(join(WEB, "src", "i18n", "t.ts"), "utf8")).toContain("MessageKey");
		expect(readFileSync(join(WEB, "src", "App.tsx"), "utf8")).toContain('t("');
	});
});

describe("design system docs", () => {
	it.each([
		["landing", join(LANDING, "docs", "DESIGN-SYSTEM.md"), "--space-4"],
		["apiweb", join(WEB, "..", "docs", "DESIGN-SYSTEM.md"), "--step-0"],
		[
			"mobile",
			join(REPO_ROOT, "factory", "templates", "mobile", "docs", "DESIGN-SYSTEM.md"),
			"spacing",
		],
	])("%s documents tokens, scales and states", (_name, path, token) => {
		const text = readFileSync(path, "utf8");
		for (const heading of [
			"Tokens de color",
			"Escala de espaciado",
			"Escala tipográfica",
			"Estados",
		]) {
			expect(text).toContain(heading);
		}
		expect(text).toContain(token);
	});
});
