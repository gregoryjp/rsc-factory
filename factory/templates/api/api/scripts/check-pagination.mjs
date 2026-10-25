import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const rootFlag = process.argv.indexOf("--root");
const root =
	rootFlag === -1
		? fileURLToPath(new URL("..", import.meta.url))
		: resolve(process.argv[rootFlag + 1]);
const modulesDir = resolve(root, "src", "modules");
const SOURCE_FILE = /\.(?:[cm]?ts|tsx)$/;
const FIND_MANY = /\bfindMany\s*\(/g;
const TAKE = /\btake\b/;

function* walk(dir) {
	for (const entry of readdirSync(dir)) {
		const full = resolve(dir, entry);
		if (statSync(full).isDirectory()) yield* walk(full);
		else if (SOURCE_FILE.test(entry)) yield full;
	}
}

const callBody = (text, openIndex) => {
	let depth = 0;
	for (let index = openIndex; index < text.length; index += 1) {
		const char = text[index];
		if (char === "(") depth += 1;
		else if (char === ")") {
			depth -= 1;
			if (depth === 0) return text.slice(openIndex, index + 1);
		}
	}
	return text.slice(openIndex);
};

function main() {
	const violations = [];
	for (const file of walk(modulesDir)) {
		if (file.includes(`${sep}__tests__${sep}`)) continue;
		const text = readFileSync(file, "utf8");
		for (const match of text.matchAll(FIND_MANY)) {
			const body = callBody(text, match.index + match[0].length - 1);
			if (!TAKE.test(body)) {
				const line = text.slice(0, match.index).split("\n").length;
				violations.push(
					`${relative(root, file)}:${line}: findMany without take; use pageWindow(parsePageQuery(...))`,
				);
			}
		}
	}
	if (violations.length > 0) {
		console.error("Unbounded list queries:");
		for (const violation of violations) console.error(`  - ${violation}`);
		process.exit(1);
	}
	console.log("Pagination OK");
}

try {
	main();
} catch (error) {
	console.error(
		`check-pagination failed closed: ${error instanceof Error ? error.message : error}`,
	);
	process.exit(1);
}
