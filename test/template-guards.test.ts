import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseUiRoutes } from "../src/domain/review/ui.js";
import { makeTempDir, REPO_ROOT } from "./helpers/env.js";

const API = join(REPO_ROOT, "factory", "templates", "apiweb", "api");
const STATIC = join(REPO_ROOT, "factory", "templates", "landing");

const tree = (files: Record<string, string>): string => {
	const root = makeTempDir();
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return root;
};

const guard = (script: string, root: string) => {
	const run = spawnSync(process.execPath, [join(API, "scripts", script), "--root", root], {
		encoding: "utf8",
	});
	return { code: run.status, out: `${run.stdout}${run.stderr}` };
};

describe("apiweb guard: check-layers", () => {
	it("rejects a service importing express and a controller importing prisma or repositories", () => {
		const root = tree({
			"src/modules/a/services/a.service.ts":
				'import type { Request } from "express";\nexport {};\n',
			"src/modules/a/controllers/a.controller.ts":
				'import { PrismaClient } from "@prisma/client";\nexport {};\n',
			"src/modules/b/controllers/b.controller.ts":
				'import { r } from "../repositories/b.repository.js";\nexport {};\n',
			"src/modules/c/controllers/c.controller.ts":
				'import { prisma } from "../../../infrastructure/database.js";\nexport {};\n',
		});
		const result = guard("check-layers.mjs", root);
		expect(result.code).toBe(1);
		expect(result.out).toContain("a.service.ts");
		expect(result.out).toContain("a.controller.ts");
		expect(result.out).toContain("b.controller.ts");
		expect(result.out).toContain("c.controller.ts");
	});

	it("accepts clean layers and ignores tests", () => {
		const root = tree({
			"src/modules/a/services/a.service.ts":
				'import { x } from "../repositories/a.repository.js";\nexport {};\n',
			"src/modules/a/controllers/a.controller.ts":
				'import type { RequestHandler } from "express";\nexport {};\n',
			"src/modules/a/__tests__/a.test.ts":
				'import { PrismaClient } from "@prisma/client";\nexport {};\n',
		});
		expect(guard("check-layers.mjs", root).code).toBe(0);
	});
});

describe("apiweb guard: check-layers bypasses", () => {
	const bad = (files: Record<string, string>, expectedFile: string) => {
		const result = guard("check-layers.mjs", tree(files));
		expect(result.code, result.out).toBe(1);
		expect(result.out).toContain(expectedFile);
	};

	it("rejects express-serve-static-core and subpath imports in services", () => {
		bad(
			{
				"src/modules/a/services/a.service.ts":
					'import type { Request } from "express-serve-static-core";\n',
			},
			"a.service.ts",
		);
		bad(
			{ "src/modules/a/services/b.service.ts": 'import type { X } from "express/lib/x";\n' },
			"b.service.ts",
		);
	});

	it("rejects services importing anything under infrastructure/http, such as respond.js", () => {
		bad(
			{
				"src/modules/a/services/a.service.ts":
					'import { sendData } from "../../../infrastructure/http/respond.js";\n',
			},
			"a.service.ts",
		);
	});

	it("rejects side-effect imports, export-from, dynamic import and require", () => {
		bad({ "src/modules/a/services/a.service.ts": 'import "express";\n' }, "a.service.ts");
		bad({ "src/modules/a/services/b.service.ts": 'export * from "express";\n' }, "b.service.ts");
		bad(
			{ "src/modules/a/services/c.service.ts": 'const x = await import("express");\n' },
			"c.service.ts",
		);
		bad(
			{ "src/modules/a/services/d.service.ts": 'const x = require("express");\n' },
			"d.service.ts",
		);
		bad(
			{ "src/modules/a/controllers/e.controller.ts": 'import "@prisma/client";\n' },
			"e.controller.ts",
		);
		bad(
			{
				"src/modules/a/controllers/f.controller.ts":
					'export { r } from "../repositories/r.repository.js";\n',
			},
			"f.controller.ts",
		);
	});

	it("rejects a controller reaching the repositories through the module index", () => {
		bad(
			{
				"src/modules/a/index.ts": 'export * from "./repositories/a.repository.js";\n',
				"src/modules/a/controllers/a.controller.ts": 'import { r } from "../index.js";\n',
			},
			"a.controller.ts",
		);
	});

	it("scans .mts and .cts files", () => {
		bad({ "src/modules/a/services/a.service.mts": 'import "express";\n' }, "a.service.mts");
		bad({ "src/modules/a/services/b.service.cts": 'import "express";\n' }, "b.service.cts");
	});

	it("resolves relative specifiers before matching", () => {
		bad(
			{
				"src/modules/a/controllers/a.controller.ts":
					'import { prisma } from "../../../infrastructure/../infrastructure/database";\n',
			},
			"a.controller.ts",
		);
	});

	it("fails closed on IO errors and on a missing modules directory", () => {
		const root = tree({ "src/modules/a/services/a.service.ts": "export {};\n" });
		symlinkSync("/nonexistent/target.ts", join(root, "src/modules/a/services/broken.service.ts"));
		const broken = guard("check-layers.mjs", root);
		expect(broken.code).toBe(1);
		expect(broken.out).toMatch(/cannot|ENOENT|error/i);
		expect(guard("check-layers.mjs", tree({ "other.txt": "x" })).code).toBe(1);
	});
});

describe("apiweb guard: check-boundaries bypasses", () => {
	it("rejects side-effect, export-from, dynamic and require deep imports and scans .mts", () => {
		for (const [name, code] of [
			["a.ts", 'import "../../a/services/a.service.js";\n'],
			["b.ts", 'export * from "../../a/services/a.service.js";\n'],
			["c.ts", 'const m = await import("../../a/services/a.service.js");\n'],
			["d.ts", 'const m = require("../../a/services/a.service.js");\n'],
			["e.mts", 'import "../../a/services/a.service.js";\n'],
		] as const) {
			const root = tree({
				"src/modules/a/index.ts": "export {};\n",
				"src/modules/a/services/a.service.ts": "export {};\n",
				[`src/modules/b/services/${name}`]: code,
			});
			const result = guard("check-boundaries.mjs", root);
			expect(result.code, name).toBe(1);
			expect(result.out).toContain(name);
		}
	});

	it("fails closed on IO errors and on a missing modules directory", () => {
		const root = tree({ "src/modules/a/index.ts": "export {};\n" });
		symlinkSync("/nonexistent/target.ts", join(root, "src/modules/a/broken.ts"));
		expect(guard("check-boundaries.mjs", root).code).toBe(1);
		expect(guard("check-boundaries.mjs", tree({ "other.txt": "x" })).code).toBe(1);
	});
});

describe("apiweb guard: check-boundaries", () => {
	it("rejects deep imports into another module and accepts index imports", () => {
		const bad = tree({
			"src/modules/a/index.ts": "export {};\n",
			"src/modules/a/services/a.service.ts": "export {};\n",
			"src/modules/b/services/b.service.ts":
				'import { x } from "../../a/services/a.service.js";\nexport {};\n',
		});
		const badResult = guard("check-boundaries.mjs", bad);
		expect(badResult.code).toBe(1);
		expect(badResult.out).toContain("only a/index.ts is public");
		const good = tree({
			"src/modules/a/index.ts": "export {};\n",
			"src/modules/b/services/b.service.ts": 'import { x } from "../../a/index.js";\nexport {};\n',
		});
		expect(guard("check-boundaries.mjs", good).code).toBe(0);
	});
});

describe("apiweb guard: check-raw-sql", () => {
	it("rejects unsafe and function-call raw SQL but accepts tagged templates", () => {
		const bad = tree({
			"src/a.ts": "await prisma.$queryRawUnsafe(sql);\n",
			"src/b.ts": "await prisma.$executeRaw(sql);\n",
		});
		const result = guard("check-raw-sql.mjs", bad);
		expect(result.code).toBe(1);
		expect(result.out).toContain("src/a.ts:1");
		expect(result.out).toContain("src/b.ts:1");
		const good = tree({ "src/a.ts": "await prisma.$queryRaw`SELECT 1`;\n" });
		expect(guard("check-raw-sql.mjs", good).code).toBe(0);
	});
});

const typescriptInstalled = existsSync(
	join(REPO_ROOT, "factory", "templates", "apiweb", "node_modules", "typescript"),
);

describe.skipIf(!typescriptInstalled)(
	`apiweb guard: check-comments (${typescriptInstalled ? "typescript available" : "SKIPPED: template node_modules not installed; covered by the Docker acceptance"})`,
	() => {
		it("rejects line and block comments and accepts comment-free code", () => {
			const bad = tree({
				"src/a.ts": "// note\nexport const a = 1;\n",
				"src/b.ts": "export const b = 1; /* note */\n",
				"prisma/schema.prisma": "// note\nmodel X { id Int @id }\n",
			});
			const result = guard("check-comments.mjs", bad);
			expect(result.code).toBe(1);
			expect(result.out).toContain("src/a.ts:1: comment");
			expect(result.out).toContain("src/b.ts:1: comment");
			expect(result.out).toContain("prisma/schema.prisma:1: comment");
			const good = tree({ "src/a.ts": 'export const a = "// not a comment";\n' });
			expect(guard("check-comments.mjs", good).code).toBe(0);
		});
	},
);

describe("static-landing check script", () => {
	const run = (root: string) => {
		const result = spawnSync(
			process.execPath,
			[join(STATIC, "scripts", "check.mjs"), "--root", root],
			{
				encoding: "utf8",
			},
		);
		return { code: result.status, out: `${result.stdout}${result.stderr}` };
	};
	const page = (extra: string) =>
		`<!doctype html><html lang="es"><head><meta name="viewport" content="width=device-width"><title>T</title>${extra}</head><body></body></html>`;

	it("passes when index.html is valid and local links resolve", () => {
		const root = tree({
			"index.html": page(
				'<link rel="stylesheet" href="styles.css"><a href="https://example.com">x</a>',
			),
			"styles.css": "body{}",
		});
		expect(run(root).code).toBe(0);
	});

	it("fails when index.html is missing or a local link is broken", () => {
		expect(run(tree({ "other.html": "x" })).out).toContain("index.html does not exist");
		const broken = run(tree({ "index.html": page('<link rel="stylesheet" href="missing.css">') }));
		expect(broken.code).toBe(1);
		expect(broken.out).toContain('"missing.css" does not resolve');
	});

	it("ships a valid default ui-routes.json and documents its format for agents", () => {
		const routes = parseUiRoutes(readFileSync(join(STATIC, "ui-routes.json"), "utf8"));
		expect(routes).toEqual({ ok: true, value: [{ path: "/", as: null }] });
		const agents = readFileSync(join(STATIC, "AGENTS.md"), "utf8");
		expect(agents).toContain("ui-routes.json");
		expect(agents).toContain('["/"]');
	});

	it("ships a valid mobile ui-routes.json and documents its format for agents", () => {
		const dir = join(REPO_ROOT, "factory", "templates", "mobile");
		const routes = parseUiRoutes(readFileSync(join(dir, "ui-routes.json"), "utf8"));
		expect(routes).toEqual({ ok: true, value: [{ path: "/", as: null }] });
		const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
		expect(agents).toContain("ui-routes.json");
		expect(agents).toContain('["/"]');
	});

	it("runs product tests in npm run check and npm test: a failing test under test/ fails both", () => {
		const root = makeTempDir();
		spawnSync("cp", ["-R", `${STATIC}/.`, root]);
		const npm = (script: string) =>
			spawnSync("npm", ["run", "-s", script], { cwd: root, encoding: "utf8" }).status;
		expect(npm("check")).toBe(0);
		expect(npm("test")).toBe(0);
		mkdirSync(join(root, "test"), { recursive: true });
		writeFileSync(
			join(root, "test", "red.test.mjs"),
			'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("red", () => assert.equal(1, 2));\n',
		);
		expect(npm("check")).not.toBe(0);
		expect(npm("test")).not.toBe(0);
	});

	it("fails when lang, title or viewport are missing", () => {
		const result = run(tree({ "index.html": "<html><head></head><body></body></html>" }));
		expect(result.code).toBe(1);
		expect(result.out).toContain("lang");
		expect(result.out).toContain("title");
		expect(result.out).toContain("viewport");
	});
});

describe("template .gitignore", () => {
	const ignored = (templateDir: string, paths: string[]) => {
		const repo = tree({ ".gitignore": readFileSync(join(templateDir, ".gitignore"), "utf8") });
		spawnSync("git", ["init", "-q"], { cwd: repo });
		return Object.fromEntries(
			paths.map((path) => {
				mkdirSync(dirname(join(repo, path)), { recursive: true });
				writeFileSync(join(repo, path), "x");
				const result = spawnSync("git", ["check-ignore", "-q", path], { cwd: repo });
				return [path, result.status === 0];
			}),
		);
	};

	it.each([
		["apiweb", join(REPO_ROOT, "factory", "templates", "apiweb")],
		["landing", STATIC],
		["mobile", join(REPO_ROOT, "factory", "templates", "mobile")],
	])("%s ignores every .env variant and .envrc but keeps the examples", (_id, dir) => {
		const result = ignored(dir, [
			".env",
			".env.local",
			"api/.env",
			"api/.env.test",
			"web/.env.production",
			"api/sub/.env.local",
			".envrc",
			"api/.envrc",
			"node_modules/x.js",
			".npm-cache/x",
			".env.example",
			"api/.env.example",
			"api/sub/.env.example",
			"api/.env.test.example",
			"index.html",
		]);
		for (const path of [
			".env",
			".env.local",
			"api/.env",
			"api/.env.test",
			"web/.env.production",
			"api/sub/.env.local",
			".envrc",
			"api/.envrc",
			"node_modules/x.js",
			".npm-cache/x",
		]) {
			expect(result[path], path).toBe(true);
		}
		for (const path of [
			".env.example",
			"api/.env.example",
			"api/sub/.env.example",
			"api/.env.test.example",
			"index.html",
		]) {
			expect(result[path], path).toBe(false);
		}
	});
});
