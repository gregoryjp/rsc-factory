import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGit } from "../src/infrastructure/git/git.js";
import { ok } from "../src/shared/result.js";
import { makeTempDir } from "./helpers/env.js";
import { commitAll } from "./helpers/exec-env.js";

const env = { PATH: process.env.PATH ?? "" };

const value = <T>(
	result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T => {
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
};

const write = (dir: string, name: string, content: string) => {
	mkdirSync(join(dir, name, ".."), { recursive: true });
	writeFileSync(join(dir, name), content);
};

const setup = () => {
	const home = makeTempDir();
	const repo = makeTempDir();
	const git = createGit({ factoryHome: home, baseEnv: env });
	value(git.init(repo, "main"));
	value(git.configureIdentity(repo, "Factory Test", "factory@localhost"));
	write(repo, "a.txt", "a");
	write(repo, "keep.test.js", "k");
	const base = value(commitAll(git, repo, "chore: base"));
	return { home, repo, git, base };
};

describe("git adapter builder operations", () => {
	it("creates and checks out the integration branch, then reuses it", () => {
		const { repo, git, base } = setup();
		expect(value(git.branchExists(repo, "factory/integration"))).toBe(false);
		value(
			git.checkoutBranch({ repoDir: repo, branch: "factory/integration", createFromSha: base }),
		);
		expect(value(git.branchExists(repo, "factory/integration"))).toBe(true);
		value(git.checkoutBranch({ repoDir: repo, branch: "factory/integration" }));
		expect(value(git.headSha(repo))).toBe(base);
		expect(
			git.checkoutBranch({ repoDir: repo, branch: "factory/other" }).ok,
			"missing branch without createFromSha",
		).toBe(false);
	});

	it("lists worktree changes (added, modified, deleted) and reads blobs by revision", () => {
		const { home, repo, git, base } = setup();
		value(
			git.checkoutBranch({ repoDir: repo, branch: "factory/integration", createFromSha: base }),
		);
		const { path } = value(
			git.worktreeAdd({
				repoDir: repo,
				runId: "run_1",
				taskKey: "t1",
				branch: "factory/task/t1",
				baseSha: base,
			}),
		);
		expect(path).toBe(join(home, "runs", "run_1", "worktrees", "t1"));
		write(path, "a.txt", "changed");
		rmSync(join(path, "keep.test.js"));
		write(path, "new/dir/n.txt", "n");
		const entries = value(git.statusEntries(path)).sort((x, y) => x.path.localeCompare(y.path));
		expect(entries).toEqual([
			{ path: "a.txt", status: "modified" },
			{ path: "keep.test.js", status: "deleted" },
			{ path: "new/dir/n.txt", status: "added" },
		]);
		expect(value(git.showFile(path, base, "a.txt"))).toBe("a");
		expect(value(git.showFile(path, base, "missing.txt"))).toBeNull();
		const oid = value(git.blobOid(path, base, "keep.test.js"));
		expect(oid).toMatch(/^[0-9a-f]{40}$/);
		const head = value(commitAll(git, path, "feat(t1): change"));
		expect(value(git.blobOid(path, head, "a.txt"))).not.toBe(
			value(git.blobOid(path, base, "a.txt")),
		);
		expect(value(git.blobOid(path, head, "keep.test.js"))).toBeNull();
		expect(git.blobOid(path, base, "../etc/passwd").ok).toBe(false);
		expect(git.showFile(path, "--bad", "a.txt").ok).toBe(false);
	});

	it("merges a slash-named task branch and resets the integration branch under the held lock", async () => {
		const { repo, git, base } = setup();
		value(
			git.checkoutBranch({ repoDir: repo, branch: "factory/integration", createFromSha: base }),
		);
		const { path } = value(
			git.worktreeAdd({
				repoDir: repo,
				runId: "run_1",
				taskKey: "t1",
				branch: "factory/task/t1",
				baseSha: base,
			}),
		);
		write(path, "b.txt", "b");
		value(commitAll(git, path, "feat(t1): b"));
		const outcome = await git.withMergeLock("run_1", async () => {
			const merged = git.mergeNoFf({
				repoDir: repo,
				runId: "run_1",
				into: "factory/integration",
				from: "factory/task/t1",
				holdsLock: true,
			});
			const second = git.mergeNoFf({
				repoDir: repo,
				runId: "run_1",
				into: "factory/integration",
				from: "factory/task/t1",
			});
			const reset = git.resetBranch({
				repoDir: repo,
				runId: "run_1",
				branch: "factory/integration",
				to: base,
				holdsLock: true,
			});
			return ok({ merged, secondCode: second.ok ? null : second.error.code, reset });
		});
		const result = value(outcome);
		expect(result.merged.ok).toBe(true);
		expect(result.secondCode).toBe("lock_held");
		expect(result.reset.ok).toBe(true);
		expect(value(git.headSha(repo))).toBe(base);
		expect(value(git.isClean(repo))).toBe(true);
	});

	it("refuses to reset a branch that is not checked out and rejects a bad target", () => {
		const { repo, git, base } = setup();
		expect(
			git.resetBranch({ repoDir: repo, runId: "run_1", branch: "factory/integration", to: base })
				.ok,
		).toBe(false);
		expect(
			git.resetBranch({ repoDir: repo, runId: "run_1", branch: "main", to: "--hard" }).ok,
		).toBe(false);
	});
});

describe("worktree pointer hardening", () => {
	const hijacked = () => {
		const { home, repo, git, base } = setup();
		value(
			git.checkoutBranch({ repoDir: repo, branch: "factory/integration", createFromSha: base }),
		);
		const { path } = value(
			git.worktreeAdd({
				repoDir: repo,
				runId: "run_1",
				taskKey: "t1",
				branch: "factory/task/t1",
				baseSha: base,
			}),
		);
		const marker = join(makeTempDir(), "filter-ran");
		for (const name of ["HEAD", "config"]) write(path, `.evil/${name}`, "");
		write(path, ".evil/HEAD", "ref: refs/heads/main\n");
		write(path, ".evil/config", `[filter "x"]\n\tclean = touch ${marker}; cat\n`);
		mkdirSync(join(path, ".evil", "objects"), { recursive: true });
		mkdirSync(join(path, ".evil", "refs"), { recursive: true });
		write(path, ".gitattributes", "* filter=x\n");
		rmSync(join(path, ".git"));
		writeFileSync(join(path, ".git"), "gitdir: .evil\n");
		return { home, repo, git, path, marker };
	};

	it("refuses every operation on a worktree whose .git pointer was replaced", () => {
		const { git, path, marker } = hijacked();
		for (const result of [
			git.statusEntries(path),
			git.stageAll(path),
			git.headSha(path),
			git.commit(path, "feat: x"),
		]) {
			expect(result).toMatchObject({ ok: false, error: { code: "worktree_pointer_tampered" } });
		}
		expect(existsSync(marker)).toBe(false);
	});

	it("commitGuarded returns worktree_pointer_tampered and never runs the filter", () => {
		const { git, path, marker } = hijacked();
		expect(commitAll(git, path, "feat: x")).toMatchObject({
			ok: false,
			error: { code: "worktree_pointer_tampered" },
		});
		expect(existsSync(marker)).toBe(false);
	});

	it("fails closed with repo_not_sealed when the seal is missing", () => {
		const { home, repo, git } = setup();
		rmSync(join(home, "repo-seals"), { recursive: true, force: true });
		expect(git.headSha(repo)).toMatchObject({ ok: false, error: { code: "repo_not_sealed" } });
		expect(git.isClean(repo)).toMatchObject({ ok: false, error: { code: "repo_not_sealed" } });
	});

	it("still allows the very first init without a seal", () => {
		const home = makeTempDir();
		const repo = makeTempDir();
		const git = createGit({ factoryHome: home, baseEnv: env });
		expect(git.init(repo, "main").ok).toBe(true);
		expect(git.isClean(repo).ok).toBe(true);
	});
});

describe("git adapter diff text for reviews", () => {
	it("returns the diff between two commits and fails with diff_too_large instead of truncating", () => {
		const { repo, git, base } = setup();
		write(repo, "a.txt", "changed");
		write(repo, "new.js", "export const n = 1;\n");
		const head = value(commitAll(git, repo, "feat: change"));
		const diff = value(git.diffText(repo, base, head, 10_000));
		expect(diff).toContain("+changed");
		expect(diff).toContain("+export const n = 1;");
		const small = git.diffText(repo, base, head, 10);
		expect(!small.ok && small.error.code).toBe("diff_too_large");
	});

	it("diffWorktree includes untracked files and truncates with a flag", () => {
		const { repo, git, base } = setup();
		write(repo, "untracked.js", "export const u = 1;\n");
		const full = value(git.diffWorktree(repo, base, 10_000));
		expect(full.truncated).toBe(false);
		expect(full.text).toContain("untracked.js");
		const cut = value(git.diffWorktree(repo, base, 20));
		expect(cut.truncated).toBe(true);
		expect(Buffer.byteLength(cut.text)).toBeLessThanOrEqual(20);
	});

	it("rejects non-commit refs", () => {
		const { repo, git } = setup();
		expect(git.diffText(repo, "--output=/tmp/x", "HEAD", 100).ok).toBe(false);
	});
});
