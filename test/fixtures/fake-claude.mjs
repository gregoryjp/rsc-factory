#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const scenario = process.env.FAKE_SCENARIO ?? "success";
if (process.env.FAKE_ARGV_FILE) {
	writeFileSync(process.env.FAKE_ARGV_FILE, JSON.stringify(process.argv.slice(2)));
}

const envelope = (overrides) =>
	JSON.stringify({
		is_error: false,
		subtype: "success",
		terminal_reason: "completed",
		total_cost_usd: 0.0069,
		structured_output: { status: "completed", summary: "ok" },
		modelUsage: { "claude-sonnet-5": { costUSD: 0.0069 } },
		...overrides,
	});

switch (scenario) {
	case "success":
		process.stdout.write(envelope({}));
		break;
	case "real_cli_2_1_258":
		process.stdout.write(
			envelope({
				duration_api_ms: 2130,
				stop_reason: "tool_use",
				session_id: "017d7d05-4ef6-416a-a768-cc5e271c2fb0",
				api_error_status: null,
				result: '{"status":"completed","summary":"ok"}',
				usage: { input_tokens: 2, cache_creation_input_tokens: 28815 },
				permission_denials: [],
				fast_mode_state: "off",
			}),
		);
		break;
	case "schema_mismatch":
		process.stdout.write(envelope({ structured_output: { status: "nope" } }));
		break;
	case "missing_output":
		process.stdout.write(envelope({ structured_output: undefined }));
		break;
	case "budget":
		process.stdout.write(
			envelope({
				is_error: true,
				subtype: "error_max_budget_usd",
				terminal_reason: "budget_exhausted",
				total_cost_usd: 1.09,
				structured_output: undefined,
				errors: ["Reached maximum budget ($0.2)"],
			}),
		);
		process.exitCode = 1;
		break;
	case "rate_limit":
		process.stdout.write(
			envelope({
				is_error: true,
				terminal_reason: "api_error",
				structured_output: undefined,
				errors: ["429 rate_limit_error: slow down"],
			}),
		);
		process.exitCode = 1;
		break;
	case "api_error":
		process.stdout.write(
			envelope({
				is_error: true,
				terminal_reason: "api_error",
				structured_output: undefined,
				total_cost_usd: 0,
			}),
		);
		process.exitCode = 1;
		break;
	case "malformed":
		process.stdout.write("this is not json");
		break;
	case "empty_fail":
		process.stderr.write("boom");
		process.exitCode = 3;
		break;
	case "sleep":
		setTimeout(() => process.stdout.write(envelope({})), 30_000);
		break;
	case "zero_cost":
		process.stdout.write(envelope({ total_cost_usd: 0 }));
		break;
	case "no_cost":
		process.stdout.write(envelope({ total_cost_usd: undefined }));
		break;
	case "overloaded":
		process.stdout.write(
			envelope({
				is_error: true,
				terminal_reason: "overloaded_error",
				structured_output: undefined,
				total_cost_usd: 0.5,
				errors: ["try later"],
			}),
		);
		process.exitCode = 1;
		break;
	case "session_limit":
		process.stdout.write(
			envelope({
				is_error: true,
				subtype: "success",
				terminal_reason: "completed",
				api_error_status: 429,
				result: "API Error: You've hit your session limit \u00b7 resets 7:30am (Europe/Madrid)",
				structured_output: undefined,
				total_cost_usd: undefined,
			}),
		);
		process.exitCode = 1;
		break;
	case "status_529":
		process.stdout.write(
			envelope({
				is_error: true,
				api_error_status: 529,
				result: "API Error: Overloaded",
				structured_output: undefined,
				total_cost_usd: undefined,
			}),
		);
		process.exitCode = 1;
		break;
	case "token_noise":
		process.stdout.write(
			envelope({
				is_error: true,
				terminal_reason: "api_error",
				structured_output: undefined,
				errors: ["connection failed at port 14290 after 5290 ms"],
			}),
		);
		process.exitCode = 1;
		break;
	case "big_utf8":
		process.stdout.write("é".repeat(600));
		break;
	case "grandchild": {
		const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
			stdio: ["ignore", "inherit", "inherit"],
		});
		writeFileSync(process.env.FAKE_PID_FILE, String(child.pid));
		setTimeout(() => {}, 60000);
		break;
	}
	default:
		process.exitCode = 9;
}
