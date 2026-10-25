import { spawn } from "node:child_process";

export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
export const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_STDERR_BYTES = 64 * 1024;

export type Completed = {
	stdout: string;
	stderr: string;
	code: number | null;
	timedOut: boolean;
	overflowed: boolean;
	aborted: boolean;
	spawnError: string | undefined;
};

export const runProcess = (
	binaryPath: string,
	args: string[],
	options: {
		cwd: string;
		env: NodeJS.ProcessEnv | undefined;
		timeoutMs: number;
		maxOutputBytes: number;
		signal: AbortSignal | undefined;
		input?: string;
	},
): Promise<Completed> =>
	new Promise((resolve) => {
		const state: Completed = {
			stdout: "",
			stderr: "",
			code: null,
			timedOut: false,
			overflowed: false,
			aborted: false,
			spawnError: undefined,
		};
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let settled = false;

		const child = spawn(binaryPath, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
		});

		const killGroup = () => {
			try {
				if (child.pid === undefined) throw new Error("no pid");
				process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};

		const settle = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutTimer);
			options.signal?.removeEventListener("abort", onAbort);
			state.code = code;
			state.stdout = Buffer.concat(stdoutChunks).toString("utf8");
			state.stderr = Buffer.concat(stderrChunks).toString("utf8");
			child.stdout.destroy();
			child.stderr.destroy();
			child.unref();
			resolve(state);
		};

		const onAbort = () => {
			state.aborted = true;
			killGroup();
			settle(null);
		};

		const timeoutTimer = setTimeout(() => {
			state.timedOut = true;
			killGroup();
			settle(null);
		}, options.timeoutMs);

		options.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdin.on("error", () => undefined);
		child.stdin.end(options.input);
		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.byteLength;
			if (stdoutBytes > options.maxOutputBytes) {
				state.overflowed = true;
				killGroup();
				settle(null);
				return;
			}
			stdoutChunks.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderrBytes >= MAX_STDERR_BYTES) return;
			stderrBytes += chunk.byteLength;
			stderrChunks.push(chunk);
		});
		child.on("error", (cause) => {
			state.spawnError = cause.message;
			settle(null);
		});
		child.on("close", (code) => settle(code));
	});
