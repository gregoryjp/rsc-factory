import { randomUUID } from "node:crypto";
import {
	linkSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { type Failure, fail, ok, type Result } from "../../shared/result.js";

export type FileLock = { release: () => void };
export type LockError = Failure<"lock_held" | "lock_io">;
export type LockHooks = { afterStaleObserved?: () => void };

const UNPARSEABLE_LOCK_GRACE_MS = 5_000;

const codeOf = (cause: unknown): string | undefined => (cause as NodeJS.ErrnoException).code;

const isAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (cause) {
		return codeOf(cause) === "EPERM";
	}
};

const readHolder = (path: string): string | undefined => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
};

const isStale = (path: string, holder: string): boolean => {
	const pid = Number.parseInt(holder.split(":")[0] ?? "", 10);
	if (Number.isInteger(pid) && pid > 0) return !isAlive(pid);
	try {
		return Date.now() - statSync(path).mtimeMs > UNPARSEABLE_LOCK_GRACE_MS;
	} catch {
		return false;
	}
};

const quietUnlink = (path: string): void => {
	try {
		unlinkSync(path);
	} catch {
		return;
	}
};

const tryCreate = (path: string, token: string): Result<FileLock, LockError> => {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, token, { flag: "wx" });
		linkSync(temporary, path);
	} catch (cause) {
		quietUnlink(temporary);
		if (codeOf(cause) === "EEXIST") return fail("lock_held", `Lock is held: ${path}`);
		const reason = cause instanceof Error ? cause.message : "unknown error";
		return fail("lock_io", `Could not create lock ${path}: ${reason}`);
	}
	quietUnlink(temporary);
	return ok({
		release: () => {
			if (readHolder(path) === token) quietUnlink(path);
		},
	});
};

export const acquireLock = (path: string, hooks: LockHooks = {}): Result<FileLock, LockError> => {
	try {
		mkdirSync(dirname(path), { recursive: true });
	} catch (cause) {
		const reason = cause instanceof Error ? cause.message : "unknown error";
		return fail("lock_io", `Could not prepare lock directory for ${path}: ${reason}`);
	}
	const token = `${process.pid}:${randomUUID()}`;
	const first = tryCreate(path, token);
	if (first.ok || first.error.code !== "lock_held") return first;
	const observed = readHolder(path);
	if (observed === undefined) return tryCreate(path, token);
	if (!isStale(path, observed)) return first;
	hooks.afterStaleObserved?.();
	const tombstone = `${path}.stale.${randomUUID()}`;
	try {
		renameSync(path, tombstone);
	} catch (cause) {
		return codeOf(cause) === "ENOENT" ? tryCreate(path, token) : first;
	}
	if (readHolder(tombstone) !== observed) {
		try {
			linkSync(tombstone, path);
		} catch {
			quietUnlink(tombstone);
			return first;
		}
		quietUnlink(tombstone);
		return first;
	}
	quietUnlink(tombstone);
	return tryCreate(path, token);
};
