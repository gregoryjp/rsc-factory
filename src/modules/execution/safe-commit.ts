import { scanFiles } from "../../domain/security/secret-scan.js";
import { ok, type Result } from "../../shared/result.js";
import type { GitPort } from "./ports.js";

export const commitGuarded = (
	git: GitPort,
	dir: string,
	message: string,
	beforeWrite: () => Result<void, { code: string; message: string }> = () => ok(undefined),
): Result<string, { code: string; message: string }> => {
	const allowed = beforeWrite();
	if (!allowed.ok) return allowed;
	const abandon = <E extends { code: string; message: string }>(failure: E): Result<never, E> => {
		git.unstageAll(dir);
		return { ok: false, error: failure };
	};
	const staged = git.stageAll(dir);
	if (!staged.ok) return abandon(staged.error);
	const files = git.stagedFiles(dir);
	if (!files.ok) return abandon(files.error);
	const findings = scanFiles(files.value);
	if (findings.length > 0) {
		const summary = findings.map((f) => `${f.file}:${f.line} (${f.rule})`).join(", ");
		return abandon({
			code: "secret_detected",
			message: `Commit blocked, possible secrets found in: ${summary}`,
		});
	}
	const again = beforeWrite();
	if (!again.ok) return abandon(again.error);
	return git.commit(dir, message);
};
