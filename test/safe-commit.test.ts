import { describe, expect, it, vi } from "vitest";
import type { GitPort } from "../src/modules/execution/ports.js";
import { commitGuarded } from "../src/modules/execution/safe-commit.js";
import { fail, ok } from "../src/shared/result.js";

const fakeGit = (overrides: Partial<GitPort>) => {
	const unstageAll = vi.fn(() => ok(undefined));
	const commit = vi.fn(() => ok("a".repeat(40)));
	const git = {
		stageAll: () => ok(undefined),
		stagedFiles: () => ok([]),
		unstageAll,
		commit,
		...overrides,
	} as unknown as GitPort;
	return { git, unstageAll, commit };
};

describe("commitGuarded", () => {
	it("unstages when reading the staged files fails (for example maxBuffer)", () => {
		const { git, unstageAll, commit } = fakeGit({
			stagedFiles: () => fail("git_failed", "maxBuffer exceeded"),
		});
		expect(commitGuarded(git, "/r", "chore: x")).toMatchObject({
			ok: false,
			error: { code: "git_failed" },
		});
		expect(unstageAll).toHaveBeenCalledTimes(1);
		expect(commit).not.toHaveBeenCalled();
	});

	it("unstages when staging itself fails halfway", () => {
		const { git, unstageAll } = fakeGit({ stageAll: () => fail("git_failed", "boom") });
		expect(commitGuarded(git, "/r", "chore: x").ok).toBe(false);
		expect(unstageAll).toHaveBeenCalledTimes(1);
	});

	it("unstages when the guard rejects after staging", () => {
		let calls = 0;
		const { git, unstageAll, commit } = fakeGit({});
		const result = commitGuarded(git, "/r", "chore: x", () => {
			calls += 1;
			return calls === 1 ? ok(undefined) : fail("target_changed", "moved");
		});
		expect(result).toMatchObject({ ok: false, error: { code: "target_changed" } });
		expect(unstageAll).toHaveBeenCalledTimes(1);
		expect(commit).not.toHaveBeenCalled();
	});
});
