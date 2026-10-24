import {
	cpSync,
	mkdirSync,
	realpathSync,
	renameSync,
	rmdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import type { TargetWriter } from "../../modules/execution/ports.js";
import { fail, ok } from "../../shared/result.js";

const isSafeRelative = (path: string): boolean => {
	const normalized = normalize(path);
	return (
		path !== "" &&
		!path.includes("\0") &&
		!isAbsolute(normalized) &&
		normalized !== ".." &&
		!normalized.startsWith(`..${sep}`)
	);
};

const message = (cause: unknown): string =>
	cause instanceof Error ? cause.message : "unknown error";

export const createFsTargetWriter = (): TargetWriter => ({
	renameDirectory: (from, to) => {
		try {
			renameSync(from, to);
			return ok(undefined);
		} catch (cause) {
			return (cause as NodeJS.ErrnoException).code === "EXDEV"
				? fail("cross_device", `Cannot rename ${from} to ${to} across devices`)
				: fail("target_write_failed", `Could not move ${from} to ${to}: ${message(cause)}`);
		}
	},
	copyDirectory: (from, to) => {
		try {
			cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
			return ok(undefined);
		} catch (cause) {
			return fail("target_write_failed", `Could not copy ${from} to ${to}: ${message(cause)}`);
		}
	},
	removeDirectory: (path) => {
		try {
			rmSync(path, { recursive: true, force: true });
			return ok(undefined);
		} catch (cause) {
			return fail("target_write_failed", `Could not remove ${path}: ${message(cause)}`);
		}
	},
	removeEmptyDirectory: (path) => {
		try {
			rmdirSync(path);
			return ok(undefined);
		} catch (cause) {
			return fail(
				"target_write_failed",
				`Could not remove empty directory ${path}: ${message(cause)}`,
			);
		}
	},
	makeDirectory: (path) => {
		try {
			mkdirSync(path, { recursive: true });
			return ok(undefined);
		} catch (cause) {
			return fail("target_write_failed", `Could not create ${path}: ${message(cause)}`);
		}
	},
	writeFile: (root, relativePath, content) => {
		if (!isSafeRelative(relativePath)) {
			return fail("target_write_failed", `Unsafe relative path: ${JSON.stringify(relativePath)}`);
		}
		const full = join(root, relativePath);
		try {
			mkdirSync(dirname(full), { recursive: true });
			const parent = relative(realpathSync(root), realpathSync(dirname(full)));
			if (parent === ".." || parent.startsWith(`..${sep}`) || isAbsolute(parent)) {
				return fail("target_write_failed", `${relativePath} resolves outside the target`);
			}
			writeFileSync(full, content, { flag: "wx", mode: 0o644 });
			return ok(undefined);
		} catch (cause) {
			return fail("target_write_failed", `Could not write ${relativePath}: ${message(cause)}`);
		}
	},
});
