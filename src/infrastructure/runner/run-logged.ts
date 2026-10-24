import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RunnerError } from "../../modules/execution/ports.js";
import { fail, ok, type Result } from "../../shared/result.js";

export const TAIL_BYTES = 4096;
export const TIMEOUT_EXIT_CODE = 124;
export const ABORT_EXIT_CODE = 130;

const KILL_GRACE_MS = 5_000;
const CONTINUATION_MASK = 0xc0;
const CONTINUATION_BITS = 0x80;

export type LoggedRun = {
	exitCode: number;
	durationMs: number;
	logSha256: string;
	tail: string;
	timedOut: boolean;
	killError: string | null;
};

export type LoggedRunInput = {
	bin: string;
	args: readonly string[];
	cwd: string;
	env: Readonly<Record<string, string>>;
	timeoutMs: number;
	logPath: string;
	killGroup: boolean;
	onTimeout?: () => Promise<string | undefined>;
	signal?: AbortSignal;
	now: () => number;
	spawnFn?: typeof spawn;
};

export const utf8Tail = (content: Buffer, maxBytes: number): string => {
	let start = Math.max(0, content.length - maxBytes);
	while (
		start < content.length &&
		start > 0 &&
		((content[start] ?? 0) & CONTINUATION_MASK) === CONTINUATION_BITS
	) {
		start += 1;
	}
	return content.subarray(start).toString("utf8");
};

export const runLogged = (input: LoggedRunInput): Promise<Result<LoggedRun, RunnerError>> =>
	new Promise((resolve) => {
		try {
			mkdirSync(dirname(input.logPath), { recursive: true });
		} catch (cause) {
			const reason = cause instanceof Error ? cause.message : "unknown error";
			resolve(fail("runner_failed", `Could not create the log directory: ${reason}`));
			return;
		}
		const log = createWriteStream(input.logPath, { flags: "w", mode: 0o600 });
		const hash = createHash("sha256");
		let tail = Buffer.alloc(0);
		let settled = false;
		let timedOut = false;
		let stopping: number | undefined;
		let killError: string | null = null;
		let stopped: Promise<void> | undefined;
		let timer: NodeJS.Timeout | undefined;
		let grace: NodeJS.Timeout | undefined;

		const record = (chunk: Buffer) => {
			if (settled) return;
			hash.update(chunk);
			log.write(chunk);
			tail = Buffer.concat([tail, chunk]).subarray(-(TAIL_BYTES + 4));
		};

		const startedAt = input.now();
		const run = input.spawnFn ?? spawn;
		const child = run(input.bin, [...input.args], {
			cwd: input.cwd,
			env: { ...input.env },
			stdio: ["ignore", "pipe", "pipe"],
			detached: input.killGroup,
		});
		child.stdout?.on("data", record);
		child.stderr?.on("data", record);

		const complete = (exitCode: number) => {
			if (settled) return;
			const logSha256 = hash.digest("hex");
			const finalTail = utf8Tail(tail, TAIL_BYTES);
			settled = true;
			clearTimeout(timer);
			clearTimeout(grace);
			input.signal?.removeEventListener("abort", onAbort);
			log.end(() =>
				resolve(
					ok({
						exitCode,
						durationMs: Math.max(0, input.now() - startedAt),
						logSha256,
						tail: finalTail,
						timedOut,
						killError,
					}),
				),
			);
		};

		const abort = (result: Result<LoggedRun, RunnerError>) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(grace);
			input.signal?.removeEventListener("abort", onAbort);
			log.end(() => resolve(result));
		};

		const stopChild = (notice: string, exitCode: number) => {
			if (stopped !== undefined || settled) return;
			stopping = exitCode;
			record(Buffer.from(`\n[factory] ${notice}\n`));
			if (input.killGroup && child.pid !== undefined) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			} else {
				child.kill("SIGKILL");
			}
			stopped = Promise.resolve(input.onTimeout?.())
				.catch((cause: unknown) => (cause instanceof Error ? cause.message : "kill failed"))
				.then((problem) => {
					if (problem !== undefined) {
						killError = problem;
						record(Buffer.from(`\n[factory] ${problem}\n`));
					}
					if (!settled) grace = setTimeout(() => complete(exitCode), KILL_GRACE_MS);
				});
		};

		timer = setTimeout(() => {
			timedOut = true;
			stopChild(`check timed out after ${input.timeoutMs} ms and was killed`, TIMEOUT_EXIT_CODE);
		}, input.timeoutMs);

		const onAbort = () => stopChild("check canceled and killed", ABORT_EXIT_CODE);
		if (input.signal?.aborted === true) onAbort();
		else input.signal?.addEventListener("abort", onAbort, { once: true });

		child.on("error", (cause) => {
			const code = (cause as NodeJS.ErrnoException).code;
			abort(
				fail(
					code === "ENOENT" ? "runner_unavailable" : "runner_failed",
					`Could not start ${input.bin}: ${cause.message}`,
				),
			);
		});
		child.on("close", (code) => {
			if (stopping !== undefined && stopped !== undefined) {
				const exitCode = stopping;
				void stopped.then(() => complete(exitCode));
				return;
			}
			complete(code ?? 1);
		});
	});
