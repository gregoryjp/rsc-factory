#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const scenario = process.env.FAKE_DOCKER_SCENARIO ?? "ok";
const log = process.env.FAKE_DOCKER_LOG;
if (log) appendFileSync(log, `${JSON.stringify(argv)}\n`);

const readStdin = () =>
	new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => resolve(data));
	});

const [first, second] = argv;
if (scenario === "no_daemon" && first === "network" && second === "create") {
	console.error("Cannot connect to the Docker daemon");
	process.exit(1);
}
if (first !== "run") process.exit(0);

const stdin = await readStdin();
if (process.env.FAKE_DOCKER_STDIN) writeFileSync(process.env.FAKE_DOCKER_STDIN, stdin);
if (scenario === "run_fail") {
	console.error("container exploded");
	process.exit(1);
}
if (scenario === "hang") setInterval(() => {}, 1000);
const mounts = argv.flatMap((arg, i) => (argv[i - 1] === "--mount" ? [arg] : []));
const home = mounts.find((m) => m.endsWith("target=/codex-home"))?.match(/source=([^,]+)/)?.[1];
if (scenario === "rotate_auth" && home) writeFileSync(join(home, "auth.json"), '{"rotated":true}');
const fixture = join(import.meta.dirname, "codex", "real_codex_docker_ok.jsonl");
process.stdout.write(readFileSync(fixture, "utf8"));
