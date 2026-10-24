import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	mkdirSync,
	openSync,
	readSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { PrdFiles } from "../../modules/runs/ports.js";
import { fail, ok } from "../../shared/result.js";

const MAX_PRD_BYTES = 5 * 1024 * 1024;

export const PRD_COPY_RELATIVE_PATH = join("input", "prd.md");

const readAll = (fd: number, size: number): Buffer => {
	const buffer = Buffer.alloc(size);
	let offset = 0;
	while (offset < size) {
		const read = readSync(fd, buffer, offset, size - offset, null);
		if (read === 0) break;
		offset += read;
	}
	return buffer.subarray(0, offset);
};

export const createFsPrdFiles = (config: { factoryHome: string }): PrdFiles => ({
	read: (path) => {
		const requested = resolve(path);
		const real = (() => {
			try {
				return realpathSync(requested);
			} catch {
				return undefined;
			}
		})();
		if (real === undefined) return fail("prd_not_found", `PRD not found: ${requested}`);

		const fd = (() => {
			try {
				return openSync(real, constants.O_RDONLY | constants.O_NONBLOCK);
			} catch {
				return undefined;
			}
		})();
		if (fd === undefined) return fail("prd_unreadable", `PRD is not readable: ${real}`);

		try {
			const stat = fstatSync(fd);
			if (!stat.isFile()) return fail("prd_not_regular_file", `PRD is not a regular file: ${real}`);
			if (stat.size > MAX_PRD_BYTES) {
				return fail("prd_too_large", `PRD exceeds ${MAX_PRD_BYTES} bytes`);
			}
			const content = readAll(fd, stat.size);
			if (content.length === 0) return fail("prd_empty", `PRD is empty: ${real}`);
			return ok({ content, hash: createHash("sha256").update(content).digest("hex") });
		} catch {
			return fail("prd_unreadable", `PRD is not readable: ${real}`);
		} finally {
			closeSync(fd);
		}
	},
	persistCopy: (runId, content) => {
		const target = join(config.factoryHome, "runs", runId, PRD_COPY_RELATIVE_PATH);
		try {
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, content, { flag: "wx", mode: 0o444 });
			return ok(PRD_COPY_RELATIVE_PATH);
		} catch (cause) {
			const reason = cause instanceof Error ? cause.message : "unknown error";
			return fail("prd_copy_failed", `Could not store PRD copy: ${reason}`);
		}
	},
});
