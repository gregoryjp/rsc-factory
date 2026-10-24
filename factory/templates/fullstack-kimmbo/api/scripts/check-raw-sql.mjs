import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootFlag = process.argv.indexOf("--root");
const root =
	rootFlag === -1
		? fileURLToPath(new URL("..", import.meta.url))
		: resolve(process.argv[rootFlag + 1]);
const SELF = fileURLToPath(import.meta.url);
const findings = [];

function* walk(dir) {
	for (const entry of readdirSync(dir)) {
		const full = resolve(dir, entry);
		if (statSync(full).isDirectory()) yield* walk(full);
		else if (/\.(ts|mjs|js)$/.test(entry) && full !== SELF) yield full;
	}
}

for (const folder of ["src", "scripts", "test"]) {
	const base = resolve(root, folder);
	try {
		statSync(base);
	} catch {
		continue;
	}
	for (const file of walk(base)) {
		readFileSync(file, "utf8")
			.split("\n")
			.forEach((line, index) => {
				const where = `${relative(root, file)}:${index + 1}`;
				if (/\$?(?:queryRawUnsafe|executeRawUnsafe)\b/.test(line)) {
					findings.push(`${where}: unsafe raw SQL API`);
				} else if (/\$?(?:queryRaw|executeRaw)\s*\(/.test(line)) {
					findings.push(`${where}: raw SQL called as a function; use the tagged template`);
				}
			});
	}
}

if (findings.length > 0) {
	console.error("Raw SQL guard failed:");
	for (const finding of findings) console.error(`  ${finding}`);
	process.exit(1);
}
console.log("Raw SQL guard OK");
