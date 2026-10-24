import { join } from "node:path";
import { isValidRunId } from "../../domain/ids/run-id.js";
import type { CheckRunnerPort, RunCheckInput, RunnerError } from "../../modules/execution/ports.js";
import { fail, ok, type Result } from "../../shared/result.js";
import type { IdGenerator } from "../ids.js";
import { runLogged } from "./run-logged.js";

const MAX_TIMER_MS = 2 ** 31 - 1;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export const validateRunCheckInput = (input: RunCheckInput): Result<void, RunnerError> => {
	if (!isValidRunId(input.runId)) return fail("invalid_input", `Invalid run id: ${input.runId}`);
	if (input.checkId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.checkId)) {
		return fail("invalid_input", `Invalid check id: ${input.checkId}`);
	}
	if (!input.cwd.startsWith("/")) return fail("invalid_input", "cwd must be an absolute path");
	if (input.argv.length === 0 || input.argv.some((arg) => arg.includes("\0"))) {
		return fail("invalid_input", "argv must be non-empty and free of NUL bytes");
	}
	if (Object.keys(input.env).some((name) => !ENV_NAME.test(name))) {
		return fail("invalid_input", "Invalid environment variable name");
	}
	if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > MAX_TIMER_MS) {
		return fail("invalid_input", "timeoutMs must be an integer between 1 and 2^31-1");
	}
	return ok(undefined);
};

export const checkLogPath = (factoryHome: string, runId: string, checkId: string): string =>
	join(factoryHome, "runs", runId, "checks", `${checkId}.log`);

export const createHostRunner = (config: {
	factoryHome: string;
	baseEnv: Readonly<Record<string, string>>;
	ids: IdGenerator;
	now: () => number;
}): CheckRunnerPort => ({
	kind: "host",
	isolated: false,
	runCheck: async (input) => {
		const valid = validateRunCheckInput(input);
		if (!valid.ok) return valid;
		const [bin, ...args] = input.argv;
		if (bin === undefined) return fail("invalid_input", "argv must be non-empty");
		const checkId = input.checkId ?? config.ids("chk");
		const logPath = checkLogPath(config.factoryHome, input.runId, checkId);
		const ran = await runLogged({
			bin,
			args,
			cwd: input.cwd,
			env: { ...config.baseEnv, ...input.env },
			timeoutMs: input.timeoutMs,
			logPath,
			killGroup: true,
			...(input.signal === undefined ? {} : { signal: input.signal }),
			now: config.now,
		});
		if (!ran.ok) return ran;
		return ok({ checkId, logPath, isolated: false, ...ran.value });
	},
	teardown: async () => ok(undefined),
});
