import { describe, expect, it } from "vitest";
import {
	classifyChanges,
	dependenciesDiffer,
	type FileChange,
	isTestPath,
	scriptsChangeKind,
	scriptsDiffer,
} from "../src/domain/builder/protected-changes.js";
import { lookupCheckPolicy, parseCheckPolicy } from "../src/domain/checks/policy.js";
import { parseBranchName } from "../src/domain/git/names.js";

describe("parseBranchName", () => {
	it("accepts factory namespaced branches and rejects traversal and odd characters", () => {
		for (const ok of ["factory/integration", "factory/task/db-schema", "main"]) {
			expect(parseBranchName(ok).ok, ok).toBe(true);
		}
		for (const bad of ["", "../x", "factory//x", "factory/Task/x", "-x", "a/b/c/d", "x y", "/x"]) {
			expect(parseBranchName(bad).ok, bad).toBe(false);
		}
	});
});

describe("scriptsChangeKind", () => {
	const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: "x", scripts });
	it("reports none when scripts are equal", () => {
		expect(scriptsChangeKind(pkg({ a: "1" }), pkg({ a: "1" }))).toBe("none");
	});
	it("treats only new non-check scripts as additive", () => {
		expect(
			scriptsChangeKind(
				pkg({ test: "vitest" }),
				pkg({ test: "vitest", "db:migrate": "prisma migrate dev" }),
			),
		).toBe("additive");
		expect(scriptsChangeKind(null, pkg({ "db:generate": "prisma generate" }))).toBe("additive");
	});
	it("protects edited, removed and check-like scripts", () => {
		expect(scriptsChangeKind(pkg({ test: "vitest" }), pkg({ test: "true" }))).toBe("protected");
		expect(scriptsChangeKind(pkg({ test: "vitest", a: "1" }), pkg({ test: "vitest" }))).toBe(
			"protected",
		);
		for (const name of [
			"check:x",
			"test:unit",
			"lint",
			"typecheck",
			"pretest",
			"postinstall",
			"prepare",
			"build",
			"format",
		]) {
			expect(scriptsChangeKind(pkg({}), pkg({ [name]: "x" })), name).toBe("protected");
		}
		expect(scriptsChangeKind(pkg({}), "{nope")).toBe("protected");
	});
});

describe("scriptsDiffer", () => {
	const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: "x", scripts });
	it("ignores key order and non-script fields, detects any script edit", () => {
		expect(scriptsDiffer(pkg({ a: "1", b: "2" }), pkg({ b: "2", a: "1" }))).toBe(false);
		expect(scriptsDiffer(pkg({ a: "1" }), JSON.stringify({ name: "y", scripts: { a: "1" } }))).toBe(
			false,
		);
		expect(scriptsDiffer(pkg({ test: "vitest" }), pkg({ test: "true" }))).toBe(true);
		expect(scriptsDiffer(pkg({ test: "vitest" }), pkg({}))).toBe(true);
	});
	it("treats an unparseable new package.json as changed and a new one without scripts as unchanged", () => {
		expect(scriptsDiffer(pkg({ a: "1" }), "{nope")).toBe(true);
		expect(scriptsDiffer(null, JSON.stringify({ name: "x" }))).toBe(false);
		expect(scriptsDiffer(null, pkg({ a: "1" }))).toBe(true);
	});
});

const change = (
	path: string,
	status: "added" | "modified" | "deleted",
	extra: Partial<FileChange> = {},
): FileChange => ({
	path,
	status,
	scriptsChanged: false,
	scriptsAdded: false,
	depsChanged: false,
	existsInBase: false,
	...extra,
});

describe("classifyChanges", () => {
	it("sends additive package scripts to review instead of blocking", () => {
		const result = classifyChanges([
			change("api/package.json", "modified", { scriptsAdded: true }),
		]);
		expect(result.blocked).toEqual([]);
		expect(result.review).toEqual(["api/package.json"]);
		expect(result.reasons["api/package.json"]).toBe("package_scripts_added");
	});

	it("blocks guard scripts, package.json scripts and test runner configs", () => {
		const result = classifyChanges([
			change("api/scripts/check-layers.mjs", "modified"),
			change("api/package.json", "modified", { scriptsChanged: true }),
			change("web/vitest.config.ts", "added"),
			change("jest.config.js", "modified"),
			change("playwright.config.ts", "modified"),
			change("api/src/new.ts", "added"),
		]);
		expect(result.blocked).toEqual([
			"api/scripts/check-layers.mjs",
			"api/package.json",
			"web/vitest.config.ts",
			"jest.config.js",
			"playwright.config.ts",
		]);
		expect(result.review).toEqual([]);
	});

	it("blocks modifying or deleting a test that exists in the base commit but allows new tests", () => {
		const result = classifyChanges([
			change("api/src/old.test.ts", "modified", { existsInBase: true }),
			change("api/src/gone.test.ts", "deleted", { existsInBase: true }),
			change("api/src/fresh.test.ts", "added"),
		]);
		expect(result.blocked).toEqual(["api/src/old.test.ts", "api/src/gone.test.ts"]);
		expect(result.reasons["api/src/old.test.ts"]).toBe("base_test_modified");
	});

	it("flags config, dependency, ignore and test support changes for review without blocking", () => {
		const result = classifyChanges([
			change("api/tsconfig.build.json", "modified"),
			change("biome.json", "modified"),
			change(".github/workflows/ci.yml", "added"),
			change("factory/policies/checks.json", "modified"),
			change("web/package.json", "modified", { depsChanged: true }),
			change("web/package.json", "modified"),
			change(".npmrc", "added"),
			change("package-lock.json", "modified"),
			change(".gitignore", "modified"),
			change("test/helpers/db.js", "added"),
			change("__fixtures__/seed.json", "modified"),
			change("__snapshots__/a.snap", "modified"),
			change("tests/data.json", "modified"),
		]);
		expect(result.blocked).toEqual([]);
		expect(result.review).toEqual([
			"api/tsconfig.build.json",
			"biome.json",
			".github/workflows/ci.yml",
			"factory/policies/checks.json",
			"web/package.json",
			".npmrc",
			"package-lock.json",
			".gitignore",
			"test/helpers/db.js",
			"__fixtures__/seed.json",
			"__snapshots__/a.snap",
			"tests/data.json",
		]);
		expect(result.reasons["web/package.json"]).toBe("dependencies_changed");
	});
});

describe("dependenciesDiffer", () => {
	const pkg = (deps: Record<string, string>) =>
		JSON.stringify({ scripts: { a: "1" }, devDependencies: deps });
	it("detects dependency edits only", () => {
		expect(dependenciesDiffer(pkg({ x: "1.0.0" }), pkg({ x: "1.0.0" }))).toBe(false);
		expect(dependenciesDiffer(pkg({ x: "1.0.0" }), pkg({ x: "2.0.0" }))).toBe(true);
		expect(dependenciesDiffer(null, pkg({ x: "1.0.0" }))).toBe(true);
		expect(dependenciesDiffer(null, JSON.stringify({ name: "x" }))).toBe(false);
	});
});

describe("check policy", () => {
	const text = JSON.stringify({
		a: { install: ["npm", "ci"], test: ["npm", "test"], check: ["npm", "run", "check"] },
	});
	it("parses and looks up by template id", () => {
		const parsed = parseCheckPolicy(text);
		if (!parsed.ok) throw new Error(parsed.error.message);
		expect(lookupCheckPolicy(parsed.value, "a")).toMatchObject({ ok: true });
		expect(lookupCheckPolicy(parsed.value, "b")).toMatchObject({
			ok: false,
			error: { code: "check_policy_missing" },
		});
	});
	it("rejects malformed policies", () => {
		for (const bad of [
			"{",
			"[]",
			JSON.stringify({ a: { test: [] } }),
			JSON.stringify({ a: { install: [], test: [], check: ["x"] } }),
		]) {
			const parsed = parseCheckPolicy(bad);
			expect(parsed.ok, bad).toBe(false);
		}
	});
});

describe("isTestPath", () => {
	it("recognizes test files and test support paths only", () => {
		for (const path of [
			"a.test.ts",
			"x/b.spec.js",
			"src/__tests__/c.ts",
			"test/h.js",
			"__fixtures__/f.json",
		]) {
			expect(isTestPath(path), path).toBe(true);
		}
		for (const path of ["src/a.ts", "contest.ts", "latest/x.ts"]) {
			expect(isTestPath(path), path).toBe(false);
		}
	});
});
