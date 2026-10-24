import { execFile } from "node:child_process";
import type { RunnerError } from "../../modules/execution/ports.js";
import { fail, ok, type Result } from "../../shared/result.js";

export const DOCKER_CALL_TIMEOUT_MS = 60_000;
const TIMED_OUT_STATUS = 124;

export type DockerCall = { status: number; stdout: string; stderr: string };

export type DockerExec = (
	args: readonly string[],
	options?: { env?: Readonly<Record<string, string>>; timeoutMs?: number },
) => Promise<Result<DockerCall, RunnerError>>;

export const createDockerExec =
	(config: { dockerBin: string; baseEnv: Readonly<Record<string, string>> }): DockerExec =>
	(args, options = {}) =>
		new Promise((resolve) => {
			execFile(
				config.dockerBin,
				[...args],
				{
					env: { ...config.baseEnv, ...options.env },
					encoding: "utf8",
					timeout: options.timeoutMs ?? DOCKER_CALL_TIMEOUT_MS,
					maxBuffer: 16 * 1024 * 1024,
				},
				(error, stdout, stderr) => {
					if (!error) return resolve(ok({ status: 0, stdout, stderr }));
					const code = (error as NodeJS.ErrnoException).code;
					if (code === "ENOENT") {
						return resolve(fail("runner_unavailable", `${config.dockerBin} not found`));
					}
					if ((error as { killed?: boolean }).killed) {
						return resolve(
							ok({ status: TIMED_OUT_STATUS, stdout, stderr: `timed out\n${stderr}` }),
						);
					}
					const status = typeof code === "number" ? code : 1;
					resolve(ok({ status, stdout, stderr }));
				},
			);
		});
