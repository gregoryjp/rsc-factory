#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const scenario = process.env.FAKE_CODEX_SCENARIO ?? "real_ok";
const fixtures = join(import.meta.dirname, "codex");
const argv = process.argv.slice(2);
const codexHome = process.env.CODEX_HOME ?? "";

const readStdin = () =>
	new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => resolve(data));
	});

const schemaPath = argv[argv.indexOf("--output-schema") + 1];
const stdin = await readStdin();

if (process.env.FAKE_CODEX_DUMP) {
	writeFileSync(
		process.env.FAKE_CODEX_DUMP,
		JSON.stringify({
			argv,
			stdin,
			cwd: process.cwd(),
			envNames: Object.keys(process.env).sort(),
			codexHome,
			home: process.env.HOME,
			homeFiles: existsSync(codexHome) ? readdirSync(codexHome).sort() : [],
			authMode: existsSync(join(codexHome, "auth.json")),
			schema: schemaPath && existsSync(schemaPath) ? readFileSync(schemaPath, "utf8") : null,
		}),
	);
}

const emit = (lines) => {
	for (const line of lines) console.log(typeof line === "string" ? line : JSON.stringify(line));
};

const completed = (
	text,
	usage = {
		input_tokens: 10,
		cached_input_tokens: 2,
		output_tokens: 3,
		reasoning_output_tokens: 1,
	},
) => [
	{ type: "thread.started", thread_id: "t" },
	{ type: "turn.started" },
	{ type: "item.completed", item: { id: "item_0", type: "agent_message", text } },
	{ type: "turn.completed", usage },
];

const failed = (message) => [
	{ type: "thread.started", thread_id: "t" },
	{ type: "turn.started" },
	{ type: "error", message },
	{ type: "turn.failed", error: { message } },
];

const replay = (name) => emit(readFileSync(join(fixtures, name), "utf8").trim().split("\n"));

const usageLimit = JSON.stringify({
	type: "error",
	status: 429,
	error: {
		type: "usage_limit_reached",
		message: "You've hit your usage limit.",
		resets_in_seconds: 3600,
	},
});

const scenarios = {
	real_ok: () => replay("real_codex_ok.jsonl"),
	real_model_not_found: () => {
		replay("real_codex_model_not_found.jsonl");
		process.exitCode = 1;
	},
	custom_ok: () => emit(completed('{"status":"completed","summary":"ok"}')),
	two_messages: () =>
		emit([
			{ type: "item.completed", item: { id: "a", type: "agent_message", text: "thinking" } },
			...completed('{"status":"completed","summary":"last"}'),
		]),
	bad_json: () => emit(completed("not json")),
	schema_mismatch: () => emit(completed('{"status":"nope"}')),
	no_message: () =>
		emit([
			{ type: "turn.started" },
			{ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
		]),
	garbage: () => console.log("this is not jsonl"),
	quota: () => {
		emit(failed(usageLimit));
		process.exitCode = 1;
	},
	rate_limit: () => {
		emit(
			failed(
				JSON.stringify({
					status: 429,
					error: { type: "rate_limit_exceeded", message: "Rate limit reached" },
				}),
			),
		);
		process.exitCode = 1;
	},
	empty_fail: () => {
		process.exitCode = 3;
	},
	rotate_auth: () => {
		writeFileSync(join(codexHome, "auth.json"), '{"rotated":true}');
		emit(completed('{"status":"completed","summary":"ok"}'));
	},
	sleep: () => {
		setTimeout(() => undefined, 60_000);
	},
};

scenarios[scenario]();
