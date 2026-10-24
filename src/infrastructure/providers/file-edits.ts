import { lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isSafeExpectedPath } from "../../domain/planning/paths.js";
import { type Failure, fail, ok, type Result } from "../../shared/result.js";

export type FileEdits = { writes?: Record<string, string>; deletes?: string[] };

const isSymlink = (path: string): boolean => {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
};

const safeJoin = (cwd: string, relative: string): Result<string, Failure<"unsafe_edit_path">> => {
	if (!isSafeExpectedPath(relative)) {
		return fail("unsafe_edit_path", `Unsafe edit path: ${JSON.stringify(relative)}`);
	}
	const segments = relative.split("/");
	let current = cwd;
	for (const segment of segments) {
		current = join(current, segment);
		if (isSymlink(current)) {
			return fail("unsafe_edit_path", `Edit path crosses a symlink: ${JSON.stringify(relative)}`);
		}
	}
	return ok(join(cwd, ...segments));
};

export const applyEdits = (
	cwd: string,
	edits: FileEdits,
): Result<void, Failure<"unsafe_edit_path">> => {
	const writes = Object.entries(edits.writes ?? {});
	const deletes = edits.deletes ?? [];
	const targets = [...writes.map(([path]) => path), ...deletes].map((path) => safeJoin(cwd, path));
	for (const target of targets) if (!target.ok) return target;
	for (const [path, content] of writes) {
		const target = safeJoin(cwd, path);
		if (!target.ok) return target;
		mkdirSync(join(target.value, ".."), { recursive: true });
		const rechecked = safeJoin(cwd, path);
		if (!rechecked.ok) return rechecked;
		writeFileSync(rechecked.value, content);
	}
	for (const path of deletes) {
		const target = safeJoin(cwd, path);
		if (!target.ok) return target;
		rmSync(target.value, { force: true });
	}
	return ok(undefined);
};
