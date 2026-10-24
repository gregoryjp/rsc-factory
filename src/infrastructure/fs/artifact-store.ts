import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import type { ArtifactStore } from "../../modules/planning/ports.js";
import { sha256Of } from "../../shared/hash.js";
import { fail, ok } from "../../shared/result.js";

const isSafeRelative = (path: string): boolean => {
	const normalized = normalize(path);
	return !isAbsolute(normalized) && normalized !== ".." && !normalized.startsWith(`..${sep}`);
};

const isExisting = (cause: unknown): boolean =>
	(cause as { code?: unknown } | null)?.code === "EEXIST";

export const createFsArtifactStore = (config: { factoryHome: string }): ArtifactStore => {
	const locate = (runId: string, relativePath: string): string | undefined =>
		isSafeRelative(relativePath) && isSafeRelative(runId)
			? join(config.factoryHome, "runs", runId, relativePath)
			: undefined;

	const writeOnce = (target: string, content: string): void =>
		writeFileSync(target, content, { flag: "wx", mode: 0o444 });

	return {
		write: (runId, relativePath, content) => {
			const target = locate(runId, relativePath);
			if (target === undefined) {
				return fail("artifact_io_failed", `Unsafe artifact path: ${relativePath}`);
			}
			try {
				mkdirSync(dirname(target), { recursive: true });
				try {
					writeOnce(target, content);
				} catch (cause) {
					if (!isExisting(cause)) throw cause;
					chmodSync(target, 0o644);
					unlinkSync(target);
					writeOnce(target, content);
				}
				return ok({ sha256: sha256Of(content), bytes: Buffer.byteLength(content) });
			} catch (cause) {
				const reason = cause instanceof Error ? cause.message : "unknown error";
				return fail("artifact_io_failed", `Could not write ${relativePath}: ${reason}`);
			}
		},
		read: (runId, relativePath) => {
			const target = locate(runId, relativePath);
			if (target === undefined) {
				return fail("artifact_io_failed", `Unsafe artifact path: ${relativePath}`);
			}
			try {
				return ok(readFileSync(target));
			} catch (cause) {
				const reason = cause instanceof Error ? cause.message : "unknown error";
				return fail("artifact_io_failed", `Could not read ${relativePath}: ${reason}`);
			}
		},
	};
};
