import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLogged, utf8Tail } from "../src/infrastructure/runner/run-logged.js";
import { makeTempDir } from "./helpers/env.js";

class FakeChild extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	pid = 4242;
	kill = vi.fn();
}

afterEach(() => {
	vi.useRealTimers();
});

const start = (child: FakeChild, overrides: Partial<Parameters<typeof runLogged>[0]> = {}) =>
	runLogged({
		bin: "docker",
		args: [],
		cwd: "/",
		env: {},
		timeoutMs: 1000,
		logPath: join(makeTempDir(), "x.log"),
		killGroup: false,
		now: Date.now,
		spawnFn: () => child as never,
		...overrides,
	});

describe("runLogged completion", () => {
	it("settles once when the process closes before the kill command resolves", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const uncaught = vi.fn();
		process.on("uncaughtException", uncaught);
		const child = new FakeChild();
		let releaseKill: (value: string | undefined) => void = () => {};
		const pending = start(child, {
			onTimeout: () => new Promise<string | undefined>((resolve) => (releaseKill = resolve)),
		});
		child.stdout.write("partial output\n");
		await vi.advanceTimersByTimeAsync(1000);
		child.emit("close", null);
		releaseKill(undefined);
		const result = await pending;
		await vi.advanceTimersByTimeAsync(20_000);
		process.off("uncaughtException", uncaught);
		expect(uncaught).not.toHaveBeenCalled();
		if (!result.ok) throw new Error(result.error.message);
		expect(result.value).toMatchObject({ exitCode: 124, timedOut: true, killError: null });
		expect(result.value.tail).toContain("partial output");
	});

	it("settles once when the kill command resolves first and close never arrives", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const uncaught = vi.fn();
		process.on("uncaughtException", uncaught);
		const child = new FakeChild();
		const pending = start(child, { onTimeout: async () => undefined });
		await vi.advanceTimersByTimeAsync(1000);
		await vi.advanceTimersByTimeAsync(6000);
		const result = await pending;
		child.emit("close", 1);
		await vi.advanceTimersByTimeAsync(20_000);
		process.off("uncaughtException", uncaught);
		expect(uncaught).not.toHaveBeenCalled();
		if (!result.ok) throw new Error(result.error.message);
		expect(result.value.exitCode).toBe(124);
	});

	it("records a failed kill instead of ignoring it", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const child = new FakeChild();
		const logPath = join(makeTempDir(), "kill.log");
		const pending = start(child, {
			logPath,
			onTimeout: async () => "docker kill failed: no such container",
		});
		await vi.advanceTimersByTimeAsync(1000);
		child.emit("close", null);
		const result = await pending;
		if (!result.ok) throw new Error(result.error.message);
		expect(result.value.killError).toBe("docker kill failed: no such container");
		expect(readFileSync(logPath, "utf8")).toContain("docker kill failed");
	});

	it("keeps the log hash equal to the bytes on disk", async () => {
		const child = new FakeChild();
		const logPath = join(makeTempDir(), "h.log");
		const pending = start(child, { logPath });
		child.stdout.write("one\n");
		child.stderr.write("two\n");
		await new Promise((resolve) => setImmediate(resolve));
		child.emit("close", 0);
		const result = await pending;
		if (!result.ok) throw new Error(result.error.message);
		const { createHash } = await import("node:crypto");
		expect(createHash("sha256").update(readFileSync(logPath)).digest("hex")).toBe(
			result.value.logSha256,
		);
	});
});

describe("utf8Tail", () => {
	it("never starts the tail in the middle of a multibyte character", () => {
		const text = `${"a".repeat(10)}${"€".repeat(10)}`;
		const tail = utf8Tail(Buffer.from(text), 7);
		expect(tail).not.toContain("�");
		expect(tail).toBe("€€");
	});

	it("returns short inputs whole", () => {
		expect(utf8Tail(Buffer.from("héllo"), 4096)).toBe("héllo");
	});
});
