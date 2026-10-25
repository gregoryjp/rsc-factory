import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootFlag = process.argv.indexOf("--root");
const apiRoot =
	rootFlag === -1
		? fileURLToPath(new URL("..", import.meta.url))
		: resolve(process.argv[rootFlag + 1]);
const productRoot = resolve(apiRoot, "..");
const DIGEST = /@sha256:[a-f0-9]{64}/;
const ROOT_USERS = new Set(["root", "0"]);

const read = (path) => readFileSync(join(productRoot, path), "utf8");

const logicalLines = (text) =>
	text
		.replace(/\\\r?\n/g, " ")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));

const parseStages = (text) => {
	const stages = [];
	for (const line of logicalLines(text)) {
		const from = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
		if (from !== null) stages.push({ image: from[1], name: from[2], lines: [] });
		else stages.at(-1)?.lines.push(line);
	}
	return stages;
};

const INSTALL = /\bnpm\s+(?:ci|install|i)\b/;
const OMIT_DEV = /--omit=dev|--production/;

function checkDockerfile(violations) {
	if (!existsSync(join(productRoot, "Dockerfile"))) {
		violations.push("Dockerfile is missing at the product root");
		return;
	}
	const stages = parseStages(read("Dockerfile"));
	if (stages.length === 0) {
		violations.push("Dockerfile has no FROM instruction");
		return;
	}
	const names = new Set(stages.map((stage) => stage.name).filter((name) => name !== undefined));
	for (const stage of stages) {
		if (!names.has(stage.image) && !DIGEST.test(stage.image)) {
			violations.push(`FROM ${stage.image} must be pinned by @sha256 digest`);
		}
	}
	const final = stages.at(-1);
	const users = final.lines.filter((line) => /^USER\s/i.test(line));
	const user = users.at(-1)?.split(/\s+/)[1]?.split(":")[0];
	if (user === undefined || ROOT_USERS.has(user)) {
		violations.push("the final stage must set a non-root USER");
	}
	if (!final.lines.some((line) => /^HEALTHCHECK\s/i.test(line))) {
		violations.push("the final stage must define a HEALTHCHECK");
	}
	if (final.lines.some((line) => INSTALL.test(line) && !OMIT_DEV.test(line))) {
		violations.push("the final stage must install with --omit=dev only");
	}
	const devStages = new Set(
		stages
			.filter((stage) => stage.lines.some((line) => INSTALL.test(line) && !OMIT_DEV.test(line)))
			.map((stage) => stage.name),
	);
	for (const line of final.lines) {
		const copy = /^COPY\s+.*--from=(\S+)\s+(.*)$/i.exec(line);
		const sources = copy === null ? [] : copy[2].split(/\s+/).slice(0, -1);
		if (
			copy !== null &&
			devStages.has(copy[1]) &&
			sources.some((source) => /(^|\/)node_modules\/?$/.test(source))
		) {
			violations.push(
				`the final stage copies node_modules from "${copy[1]}", which has dev dependencies`,
			);
		}
	}
	if (
		!stages.some((stage) => stage.lines.some((line) => INSTALL.test(line) && OMIT_DEV.test(line)))
	) {
		violations.push("no stage installs production dependencies with --omit=dev");
	}
}

function checkFiles(violations) {
	if (!existsSync(join(productRoot, ".dockerignore"))) {
		violations.push(".dockerignore is missing");
	} else {
		const ignore = read(".dockerignore")
			.split("\n")
			.map((line) => line.trim());
		for (const entry of ["node_modules", ".env", ".git"]) {
			if (!ignore.includes(entry)) violations.push(`.dockerignore must list ${entry}`);
		}
	}
	if (!existsSync(join(productRoot, "docker-compose.prod.example.yml"))) {
		violations.push("docker-compose.prod.example.yml is missing");
	} else if (!/^\s*read_only:\s*true\s*$/m.test(read("docker-compose.prod.example.yml"))) {
		violations.push("docker-compose.prod.example.yml must run the api with read_only: true");
	}
	const workflow = join(".github", "workflows", "ci.yml");
	if (!existsSync(join(productRoot, workflow))) {
		violations.push(`${workflow} is missing`);
		return;
	}
	const ci = read(workflow);
	for (const needle of ["npm audit --omit=dev", "docker build"]) {
		if (!ci.includes(needle)) violations.push(`${workflow} must run "${needle}"`);
	}
}

function main() {
	const violations = [];
	checkDockerfile(violations);
	checkFiles(violations);
	if (violations.length > 0) {
		console.error("Deployment baseline violations:");
		for (const violation of violations) console.error(`  - ${violation}`);
		process.exit(1);
	}
	console.log("Deployment baseline OK");
}

try {
	main();
} catch (error) {
	console.error(`check-deploy failed closed: ${error instanceof Error ? error.message : error}`);
	process.exit(1);
}
