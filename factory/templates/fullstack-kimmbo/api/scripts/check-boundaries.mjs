import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const rootFlag = process.argv.indexOf("--root");
const root =
	rootFlag === -1
		? fileURLToPath(new URL("..", import.meta.url))
		: resolve(process.argv[rootFlag + 1]);
const modulesDir = resolve(root, "src", "modules");
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

function main() {
	const violations = [];
	for (const file of walk(modulesDir)) {
		const current = relative(modulesDir, file).split(sep)[0];
		for (const match of readFileSync(file, "utf8").matchAll(IMPORT_RE)) {
			const specifier = match[1];
			if (!specifier.startsWith(".")) continue;
			const target = resolve(dirname(file), specifier);
			const targetRelative = relative(modulesDir, target);
			if (targetRelative.startsWith("..")) continue;
			const targetModule = targetRelative.split(sep)[0];
			if (targetModule === current) continue;
			if (target.replace(EXTENSION, "") !== resolve(modulesDir, targetModule, "index")) {
				violations.push(
					`${relative(root, file)} imports "${specifier}": only ${targetModule}/index.ts is public`,
				);
			}
		}
	}
	if (violations.length > 0) {
		console.error("Module-boundary violations:");
		for (const violation of violations) console.error(`  - ${violation}`);
		process.exit(1);
	}
	console.log("Module boundaries OK");
}

try {
	main();
} catch (error) {
	console.error(
		`check-boundaries failed closed: ${error instanceof Error ? error.message : error}`,
	);
	process.exit(1);
}
