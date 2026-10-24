import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const rootFlag = process.argv.indexOf("--root");
const root =
	rootFlag === -1
		? fileURLToPath(new URL("..", import.meta.url))
		: resolve(process.argv[rootFlag + 1]);
const srcDir = resolve(root, "src");
const modulesDir = resolve(srcDir, "modules");
const httpDir = resolve(srcDir, "infrastructure", "http");
const databaseBase = resolve(srcDir, "infrastructure", "database");

const SOURCE_FILE = /\.(?:[cm]?ts|tsx)$/;
const EXTENSION = /\.(?:[cm]?[jt]s|tsx)$/;
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;

function* walk(dir) {
	for (const entry of readdirSync(dir)) {
		const full = resolve(dir, entry);
		if (statSync(full).isDirectory()) yield* walk(full);
		else if (SOURCE_FILE.test(entry)) yield full;
	}
}

const stripExtension = (path) => path.replace(EXTENSION, "");
const isUnder = (path, dir) => path === dir || path.startsWith(`${dir}${sep}`);
const isPackage = (spec, name) => spec === name || spec.startsWith(`${name}/`);

const RULES = {
	services: (spec, resolved, moduleIndex) => {
		if (isPackage(spec, "express") || isPackage(spec, "express-serve-static-core")) {
			return "services must not import express";
		}
		if (resolved && isUnder(stripExtension(resolved), httpDir)) {
			return "services must not import infrastructure/http";
		}
		if (resolved && stripExtension(resolved) === moduleIndex) {
			return "services must not import the module index";
		}
		return undefined;
	},
	controllers: (spec, resolved, moduleIndex) => {
		if (isPackage(spec, "@prisma/client")) return "controllers must not import prisma";
		if (resolved) {
			const base = stripExtension(resolved);
			if (base === databaseBase || isUnder(base, databaseBase)) {
				return "controllers must not import the database";
			}
			if (relative(srcDir, base).split(sep).includes("repositories")) {
				return "controllers must not import repositories";
			}
			if (base === moduleIndex) return "controllers must not import the module index";
		}
		return undefined;
	},
};

function main() {
	const violations = [];
	for (const file of walk(modulesDir)) {
		const [moduleName, layer] = relative(modulesDir, file).split(sep);
		const rule = RULES[layer];
		if (rule === undefined || file.includes(`${sep}__tests__${sep}`)) continue;
		const moduleIndex = resolve(modulesDir, moduleName, "index");
		for (const match of readFileSync(file, "utf8").matchAll(IMPORT_RE)) {
			const spec = match[1];
			const resolved = spec.startsWith(".") ? resolve(dirname(file), spec) : undefined;
			const problem = rule(spec, resolved, moduleIndex);
			if (problem !== undefined)
				violations.push(`${relative(root, file)} imports "${spec}": ${problem}`);
		}
	}
	if (violations.length > 0) {
		console.error("Layer violations:");
		for (const violation of violations) console.error(`  - ${violation}`);
		process.exit(1);
	}
	console.log("Layers OK");
}

try {
	main();
} catch (error) {
	console.error(`check-layers failed closed: ${error instanceof Error ? error.message : error}`);
	process.exit(1);
}
