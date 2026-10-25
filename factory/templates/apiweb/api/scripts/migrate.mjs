import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const COMMANDS = new Set(["deploy", "status"]);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [command = "deploy", ...flags] = process.argv.slice(2);

const fail = (message) => {
	console.error(`migrate: ${message}`);
	process.exit(2);
};

if (!COMMANDS.has(command)) fail(`unknown command "${command}"; use deploy or status`);

const source = [process.env.MIGRATION_DATABASE_URL, process.env.DATABASE_URL].find(
	(value) => value !== undefined && value !== "",
);
const sourceName =
	process.env.MIGRATION_DATABASE_URL !== undefined && process.env.MIGRATION_DATABASE_URL !== ""
		? "MIGRATION_DATABASE_URL"
		: "DATABASE_URL";
if (source === undefined) fail("neither MIGRATION_DATABASE_URL nor DATABASE_URL is set");

if (flags.includes("--dry-run")) {
	console.log(`migrate ${command} would use ${sourceName}`);
	process.exit(0);
}

const prismaPackage = createRequire(import.meta.url).resolve("prisma/package.json");
const run = spawnSync(
	process.execPath,
	[join(dirname(prismaPackage), "build", "index.js"), "migrate", command],
	{ cwd: root, env: { ...process.env, DATABASE_URL: source }, stdio: "inherit" },
);
process.exit(run.status ?? 1);
