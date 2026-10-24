import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import type { TargetState } from "../../domain/audit/target-state.js";
import { sha256Of } from "../../shared/hash.js";
import { fail, ok, type Result } from "../../shared/result.js";
import type { ReadOnlyGitPort } from "../git/read-only-git.js";

const fingerprintOf = (path: string): string => {
	try {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) return `symlink:${readlinkSync(path)}`;
		if (stat.isFile()) return sha256Of(readFileSync(path));
		return stat.isDirectory() ? "directory" : "special";
	} catch {
		return "missing";
	}
};

export const captureTargetState = (
	git: ReadOnlyGitPort,
	dir: string,
): Result<TargetState, { code: string; message: string }> => {
	const head = git.headSha(dir);
	if (!head.ok) return head;
	const status = git.statusPorcelainV2(dir);
	if (!status.ok) return status;
	const listed = git.listFiles(dir);
	if (!listed.ok) return listed;
	const files: Record<string, string> = {};
	for (const path of listed.value) files[path] = fingerprintOf(join(dir, path));
	if (Object.keys(files).length !== listed.value.length) {
		return fail("target_state_failed", "The target lists the same path twice");
	}
	return ok({ head: head.value, status: status.value, files });
};
