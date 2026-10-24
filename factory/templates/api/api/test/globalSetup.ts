import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { assertTestDatabase } from "./db.js";

export default function globalSetup(): void {
	assertTestDatabase();
	const root = resolve(import.meta.dirname, "..");
	const prismaPackage = createRequire(import.meta.url).resolve("prisma/package.json");
	execFileSync(
		process.execPath,
		[join(dirname(prismaPackage), "build", "index.js"), "migrate", "deploy"],
		{
			cwd: root,
			env: process.env,
			stdio: "inherit",
		},
	);
}
