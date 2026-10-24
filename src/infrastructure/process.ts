import { execFile } from "node:child_process";
import type { CommandRunner } from "../modules/doctor/run-doctor.js";
import { err, type Failure, ok } from "../shared/result.js";

export type CommandError = Failure<"not_found" | "failed" | "timeout">;

export const execCommand: CommandRunner = (bin, args, timeoutMs) =>
	new Promise((resolve) => {
		execFile(bin, [...args], { timeout: timeoutMs, encoding: "utf8" }, (error, stdout) => {
			if (!error) {
				resolve(ok({ stdout }));
				return;
			}
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") resolve(err({ code: "not_found", message: `${bin} not found` }));
			else if (error.killed) resolve(err({ code: "timeout", message: `${bin} timed out` }));
			else resolve(err({ code: "failed", message: error.message }));
		});
	});
