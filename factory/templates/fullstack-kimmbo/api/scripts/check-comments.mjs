import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const rootFlag = process.argv.indexOf("--root");
const root =
	rootFlag === -1
		? fileURLToPath(new URL("..", import.meta.url))
		: resolve(process.argv[rootFlag + 1]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);
const SKIPPED = new Set(["node_modules", "dist", "coverage", ".git", ".npm-cache"]);

function* walk(directory) {
	for (const entry of readdirSync(directory)) {
		const full = join(directory, entry);
		if (statSync(full).isDirectory()) {
			if (!SKIPPED.has(entry)) yield* walk(full);
		} else if (SOURCE_EXTENSIONS.has(extname(entry))) {
			yield full;
		}
	}
}

function commentLines(file) {
	const text = readFileSync(file, "utf8");
	const kind = [".ts", ".tsx", ".mts", ".cts"].includes(extname(file))
		? ts.ScriptKind.TS
		: ts.ScriptKind.JS;
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
	const found = new Map();
	const collect = (ranges) => {
		for (const range of ranges ?? []) {
			found.set(range.pos, source.getLineAndCharacterOfPosition(range.pos).line + 1);
		}
	};
	const visit = (node) => {
		collect(ts.getLeadingCommentRanges(text, node.getFullStart()));
		collect(ts.getTrailingCommentRanges(text, node.getEnd()));
		for (const child of node.getChildren(source)) visit(child);
	};
	visit(source);
	collect(ts.getLeadingCommentRanges(text, source.endOfFileToken.getFullStart()));
	return [...found.values()].sort((a, b) => a - b);
}

function schemaCommentLines(file) {
	return readFileSync(file, "utf8")
		.split("\n")
		.flatMap((line, index) =>
			line.replace(/"(?:[^"\\]|\\.)*"/g, '""').includes("//") ? [index + 1] : [],
		);
}

let total = 0;
for (const file of walk(root)) {
	for (const line of commentLines(file)) {
		console.log(`${relative(root, file)}:${line}: comment`);
		total += 1;
	}
}
const schema = resolve(root, "prisma", "schema.prisma");
try {
	statSync(schema);
	for (const line of schemaCommentLines(schema)) {
		console.log(`${relative(root, schema)}:${line}: comment`);
		total += 1;
	}
} catch {}

if (total > 0) {
	console.error(`${total} comment(s) found. Comments are not allowed: put explanations in docs.`);
	process.exit(1);
}
console.log("No comments found");
