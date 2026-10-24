import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGit } from "../src/infrastructure/git/git.js";
import { acquireLock } from "../src/infrastructure/git/lock.js";
import { makeTempDir } from "./helpers/env.js";
import { commitAll } from "./helpers/exec-env.js";

const env = { PATH: process.env.PATH ?? "" };

const setup = () => {
	const home = makeTempDir();
	const repo = makeTempDir();
	const git = createGit({ factoryHome: home, baseEnv: env });
	expect(git.init(repo, "main").ok).toBe(true);
	expect(git.configureIdentity(repo, "Factory Test", "factory@localhost").ok).toBe(true);
	return { home, repo, git };
};

const write = (dir: string, name: string, content: string) => {
	mkdirSync(join(dir, name, ".."), { recursive: true });
	writeFileSync(join(dir, name), content);
};

const raw = (cwd: string, args: string[]) =>
	spawnSync("git", args, { cwd, encoding: "utf8", env }).stdout.trim();

const value = <T>(
	result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T => {
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
};

describe("git adapter", () => {
	it("init + commitAll returns a 40-char sha equal to HEAD", () => {
		const { repo, git } = setup();
		write(repo, "a.txt", "a");
		const sha = value(commitAll(git, repo, "chore: first"));
		expect(sha).toMatch(/^[0-9a-f]{40}$/);
		expect(value(git.headSha(repo))).toBe(sha);
		expect(raw(repo, ["log", "-1", "--format=%an <%ae>|%s"])).toBe(
			"Factory Test <factory@localhost>|chore: first",
		);
		expect(value(git.commitExists(repo, sha))).toBe(true);
		expect(value(git.commitExists(repo, "0".repeat(40)))).toBe(false);
	});

	it("reports whether the working tree is clean, counting untracked files", () => {
		const { repo, git } = setup();
		write(repo, "a.txt", "a");
		expect(value(git.isClean(repo))).toBe(false);
		value(commitAll(git, repo, "chore: first"));
		expect(value(git.isClean(repo))).toBe(true);
		write(repo, "a.txt", "changed");
		expect(value(git.isClean(repo))).toBe(false);
	});

	it("reports nothing_to_commit on a clean tree", () => {
		const { repo, git } = setup();
		write(repo, "a.txt", "a");
		value(commitAll(git, repo, "chore: first"));
		expect(commitAll(git, repo, "chore: again")).toMatchObject({
			ok: false,
			error: { code: "nothing_to_commit" },
		});
	});

	it("never runs repository hooks", () => {
		const { repo, git } = setup();
		const hook = join(repo, ".git", "hooks", "pre-commit");
		writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		write(repo, "a.txt", "a");
		expect(commitAll(git, repo, "chore: hooks").ok).toBe(true);
	});

	it("lists staged files with their staged content", () => {
		const { repo, git } = setup();
		write(repo, "dir/a.txt", "hello");
		write(repo, "b.txt", "world");
		value(git.stageAll(repo));
		const files = value(git.stagedFiles(repo));
		expect(files.map((f) => [f.path, f.content]).sort()).toEqual([
			["b.txt", "world"],
			["dir/a.txt", "hello"],
		]);
		value(git.unstageAll(repo));
		expect(raw(repo, ["diff", "--cached", "--name-only"])).toBe("");
	});

	it("adds and removes a worktree under FACTORY_HOME/runs/<runId>/worktrees/<taskKey>", () => {
		const { home, repo, git } = setup();
		write(repo, "a.txt", "a");
		const base = value(commitAll(git, repo, "chore: base"));
		const added = value(
			git.worktreeAdd({
				repoDir: repo,
				runId: "run_1",
				taskKey: "task-one",
				branch: "task-one",
				baseSha: base,
			}),
		);
		expect(added.path).toBe(join(home, "runs", "run_1", "worktrees", "task-one"));
		expect(readFileSync(join(added.path, "a.txt"), "utf8")).toBe("a");
		expect(
			git.worktreeAdd({
				repoDir: repo,
				runId: "run_1",
				taskKey: "task-one",
				branch: "other",
				baseSha: base,
			}),
		).toMatchObject({
			ok: false,
		});
		write(added.path, "b.txt", "b");
		const head = value(commitAll(git, added.path, "feat: b"));
		expect(value(git.diffNames(repo, base, head))).toEqual(["b.txt"]);
		value(git.worktreeRemove({ repoDir: repo, runId: "run_1", taskKey: "task-one" }));
		expect(existsSync(added.path)).toBe(false);
	});

	it("merges a task branch with --no-ff creating a merge commit", () => {
		const { repo, git } = setup();
		write(repo, "a.txt", "a");
		const base = value(commitAll(git, repo, "chore: base"));
		const wt = value(
			git.worktreeAdd({
				repoDir: repo,
				runId: "run_1",
				taskKey: "t1",
				branch: "t1",
				baseSha: base,
			}),
		);
		write(wt.path, "b.txt", "b");
		value(commitAll(git, wt.path, "feat: b"));
		const merged = value(
			git.mergeNoFf({ repoDir: repo, runId: "run_1", into: "main", from: "t1" }),
		);
		expect(value(git.headSha(repo))).toBe(merged);
		expect(raw(repo, ["log", "-1", "--format=%P"]).split(" ")).toHaveLength(2);
		expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("b");
	});

	it("aborts a conflicting merge and leaves the repository clean", () => {
		const { repo, git } = setup();
		write(repo, "a.txt", "base");
		const base = value(commitAll(git, repo, "chore: base"));
		const wt = value(
			git.worktreeAdd({
				repoDir: repo,
				runId: "run_1",
				taskKey: "t1",
				branch: "t1",
				baseSha: base,
			}),
		);
		write(wt.path, "a.txt", "branch");
		value(commitAll(git, wt.path, "feat: branch"));
		write(repo, "a.txt", "main");
		const mainHead = value(commitAll(git, repo, "feat: main"));
		expect(
			git.mergeNoFf({ repoDir: repo, runId: "run_1", into: "main", from: "t1" }),
		).toMatchObject({
			ok: false,
			error: { code: "merge_conflict" },
		});
		expect(existsSync(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
		expect(value(git.headSha(repo))).toBe(mainHead);
		expect(raw(repo, ["status", "--porcelain"])).toBe("");
	});

	it("refuses to merge when the target branch is not checked out", () => {
		const { repo, git } = setup();
		write(repo, "a.txt", "a");
		const base = value(commitAll(git, repo, "chore: base"));
		expect(
			git.mergeNoFf({ repoDir: repo, runId: "run_1", into: "release", from: "main" }),
		).toMatchObject({
			ok: false,
			error: { code: "not_checked_out" },
		});
		expect(base).toHaveLength(40);
	});

	it("rejects unsafe branch, task key, run id and refs before running git", () => {
		const { repo, git } = setup();
		write(repo, "a.txt", "a");
		const base = value(commitAll(git, repo, "chore: base"));
		const bad = (r: { ok: boolean; error?: { code: string } }) =>
			expect(r).toMatchObject({ ok: false, error: { code: "invalid_git_name" } });
		bad(
			git.worktreeAdd({
				repoDir: repo,
				runId: "run_1",
				taskKey: "../escape",
				branch: "ok",
				baseSha: base,
			}),
		);
		bad(
			git.worktreeAdd({
				repoDir: repo,
				runId: "run_1",
				taskKey: "ok",
				branch: "--orphan",
				baseSha: base,
			}),
		);
		bad(
			git.worktreeAdd({
				repoDir: repo,
				runId: "../run",
				taskKey: "ok",
				branch: "ok",
				baseSha: base,
			}),
		);
		bad(
			git.worktreeAdd({
				repoDir: repo,
				runId: "run_1",
				taskKey: "ok",
				branch: "ok",
				baseSha: "--all",
			}),
		);
		bad(git.diffNames(repo, "--all", base));
		bad(git.mergeNoFf({ repoDir: repo, runId: "run_1", into: "main", from: "-x" }));
		bad(git.worktreeRemove({ repoDir: repo, runId: "run_1", taskKey: "a/b" }));
	});
});

describe("merge lock", () => {
	it("is exclusive and released on demand", () => {
		const dir = makeTempDir();
		const path = join(dir, "locks", "run_1.merge.lock");
		const first = acquireLock(path);
		expect(first.ok).toBe(true);
		expect(acquireLock(path)).toMatchObject({ ok: false, error: { code: "lock_held" } });
		if (first.ok) first.value.release();
		const again = acquireLock(path);
		expect(again.ok).toBe(true);
		if (again.ok) again.value.release();
		expect(existsSync(path)).toBe(false);
	});

	it("takes over a lock whose owner process is dead", () => {
		const dir = makeTempDir();
		const path = join(dir, "run_1.merge.lock");
		const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
			encoding: "utf8",
		});
		writeFileSync(path, `${child.stdout}:dead-token`);
		const taken = acquireLock(path);
		expect(taken.ok).toBe(true);
		if (taken.ok) {
			expect(readFileSync(path, "utf8").split(":")[0]).toBe(String(process.pid));
			taken.value.release();
		}
	});

	it("does not take over a lock owned by a live process", () => {
		const dir = makeTempDir();
		const path = join(dir, "run_1.merge.lock");
		writeFileSync(path, `${process.pid}:live-token`);
		expect(acquireLock(path)).toMatchObject({ ok: false, error: { code: "lock_held" } });
	});

	it("serializes two merges for the same run", () => {
		const { home, repo, git } = setup();
		write(repo, "a.txt", "a");
		const base = value(commitAll(git, repo, "chore: base"));
		const wt = value(
			git.worktreeAdd({
				repoDir: repo,
				runId: "run_1",
				taskKey: "t1",
				branch: "t1",
				baseSha: base,
			}),
		);
		write(wt.path, "b.txt", "b");
		value(commitAll(git, wt.path, "feat: b"));
		const held = acquireLock(join(home, "locks", "run_1.merge.lock"));
		expect(held.ok).toBe(true);
		expect(
			git.mergeNoFf({ repoDir: repo, runId: "run_1", into: "main", from: "t1" }),
		).toMatchObject({
			ok: false,
			error: { code: "lock_held" },
		});
		if (held.ok) held.value.release();
		expect(git.mergeNoFf({ repoDir: repo, runId: "run_1", into: "main", from: "t1" }).ok).toBe(
			true,
		);
	});
});

describe("repository seal against repo-local config tampering", () => {
	const tamper = (repo: string, marker: string) =>
		appendFileSync(join(repo, ".git", "config"), `[core]\n\tfsmonitor = touch ${marker}\n`);

	it("refuses every operation after .git/config changes and never runs the injected command", () => {
		const { repo, git } = setup();
		write(repo, "a.txt", "a");
		value(commitAll(git, repo, "chore: base"));
		const marker = join(makeTempDir(), "fsmonitor-ran");
		tamper(repo, marker);
		for (const result of [
			git.isClean(repo),
			git.headSha(repo),
			git.stageAll(repo),
			git.diffNames(repo, "main", "main"),
			git.commitExists(repo, "a".repeat(40)),
		]) {
			expect(result).toMatchObject({ ok: false, error: { code: "repo_config_tampered" } });
		}
		expect(existsSync(marker)).toBe(false);
	});

	it("refuses a tampered config combined with a filter driver in .gitattributes", () => {
		const { repo, git } = setup();
		write(repo, ".gitattributes", "* filter=evil\n");
		write(repo, "a.txt", "a");
		value(commitAll(git, repo, "chore: base"));
		const marker = join(makeTempDir(), "filter-ran");
		appendFileSync(
			join(repo, ".git", "config"),
			`[filter "evil"]\n\tclean = touch ${marker}; cat\n\tsmudge = touch ${marker}; cat\n`,
		);
		write(repo, "a.txt", "changed");
		expect(commitAll(git, repo, "chore: again")).toMatchObject({
			ok: false,
			error: { code: "repo_config_tampered" },
		});
		expect(existsSync(marker)).toBe(false);
	});

	it("also detects changes to .git/info/attributes", () => {
		const { repo, git } = setup();
		write(repo, "a.txt", "a");
		value(commitAll(git, repo, "chore: base"));
		mkdirSync(join(repo, ".git", "info"), { recursive: true });
		writeFileSync(join(repo, ".git", "info", "attributes"), "* filter=evil\n");
		expect(git.headSha(repo)).toMatchObject({ ok: false, error: { code: "repo_config_tampered" } });
	});

	it("keeps working after legitimate engine operations such as worktree add", () => {
		const { repo, git } = setup();
		write(repo, "a.txt", "a");
		const base = value(commitAll(git, repo, "chore: base"));
		value(
			git.worktreeAdd({
				repoDir: repo,
				runId: "run_1",
				taskKey: "t1",
				branch: "t1",
				baseSha: base,
			}),
		);
		expect(git.isClean(repo).ok).toBe(true);
		expect(git.sealRepo(repo).ok).toBe(true);
	});
});

describe("snapshot", () => {
	it("materializes exactly the commit without .git and without running filters", () => {
		const { repo, git } = setup();
		write(repo, ".gitattributes", "* filter=evil\n");
		write(repo, "a.txt", "committed");
		write(repo, "dir/b.txt", "b");
		const sha = value(commitAll(git, repo, "chore: base"));
		write(repo, "a.txt", "dirty");
		write(repo, "untracked.txt", "u");
		const dest = join(makeTempDir(), "snap");
		expect(git.snapshot(repo, sha, dest).ok).toBe(true);
		expect(readFileSync(join(dest, "a.txt"), "utf8")).toBe("committed");
		expect(readFileSync(join(dest, "dir/b.txt"), "utf8")).toBe("b");
		expect(existsSync(join(dest, "untracked.txt"))).toBe(false);
		expect(existsSync(join(dest, ".git"))).toBe(false);
	});

	it("never runs clean or smudge filters, preserves executable bits and skips nothing else", () => {
		const { repo, git } = setup();
		write(repo, ".gitattributes", "* filter=evil\n");
		write(repo, "a.txt", "a");
		write(repo, "run.sh", "#!/bin/sh\n");
		chmodSync(join(repo, "run.sh"), 0o755);
		const sha = value(commitAll(git, repo, "chore: base"));
		const marker = join(makeTempDir(), "filter-ran");
		appendFileSync(
			join(repo, ".git", "config"),
			`[filter "evil"]\n\tsmudge = touch ${marker}; cat\n\tclean = touch ${marker}; cat\n`,
		);
		value(git.sealRepo(repo));
		const dest = join(makeTempDir(), "snap");
		value(git.snapshot(repo, sha, dest));
		expect(existsSync(marker)).toBe(false);
		expect(readFileSync(join(dest, "a.txt"), "utf8")).toBe("a");
		expect(statSync(join(dest, "run.sh")).mode & 0o111).not.toBe(0);
	});

	it("refuses to snapshot from a tampered repository", () => {
		const { repo, git } = setup();
		write(repo, "a.txt", "a");
		const sha = value(commitAll(git, repo, "chore: base"));
		appendFileSync(join(repo, ".git", "config"), "[core]\n\tfsmonitor = true\n");
		expect(git.snapshot(repo, sha, join(makeTempDir(), "snap"))).toMatchObject({
			ok: false,
			error: { code: "repo_config_tampered" },
		});
	});

	describe("symlink targets", () => {
		const withLink = (path: string, target: string) => {
			const { repo, git } = setup();
			write(repo, "a.txt", "a");
			const plumb = (args: string[], input: string) =>
				spawnSync("git", args, { cwd: repo, encoding: "utf8", env, input }).stdout.trim();
			const fileOid = plumb(["hash-object", "-w", "--stdin"], "a");
			const linkOid = plumb(["hash-object", "-w", "--stdin"], target);
			const leaf = path.split("/").pop() ?? path;
			const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
			const inner = plumb(["mktree"], `120000 blob ${linkOid}\t${leaf}\n`);
			const root = plumb(
				["mktree"],
				dir === ""
					? `100644 blob ${fileOid}\ta.txt\n120000 blob ${linkOid}\t${leaf}\n`
					: `100644 blob ${fileOid}\ta.txt\n040000 tree ${inner}\t${dir}\n`,
			);
			const sha = plumb(["commit-tree", root, "-m", "link"], "");
			return { git, repo, sha, dest: join(makeTempDir(), "snap") };
		};

		it("rejects an absolute symlink target", () => {
			const { git, repo, sha, dest } = withLink("link", "/etc/passwd");
			expect(git.snapshot(repo, sha, dest)).toMatchObject({
				ok: false,
				error: { code: "unsafe_symlink" },
			});
		});

		it("rejects a target that escapes the snapshot root", () => {
			const { git, repo, sha, dest } = withLink("d/link", "../../x");
			expect(git.snapshot(repo, sha, dest)).toMatchObject({
				ok: false,
				error: { code: "unsafe_symlink" },
			});
		});

		it("accepts a relative target that stays inside the root", () => {
			const { git, repo, sha, dest } = withLink("d/link", "../a.txt");
			expect(git.snapshot(repo, sha, dest).ok).toBe(true);
			expect(readlinkSync(join(dest, "d", "link"))).toBe("../a.txt");
		});
	});

	it("refuses a tree where an entry path is nested under a symlink entry", () => {
		const { repo, git } = setup();
		const outside = makeTempDir();
		const plumb = (args: string[], input: string) =>
			spawnSync("git", args, { cwd: repo, encoding: "utf8", env, input }).stdout.trim();
		const linkOid = plumb(["hash-object", "-w", "--stdin"], outside);
		const fileOid = plumb(["hash-object", "-w", "--stdin"], "pwned");
		const subtree = plumb(["mktree"], `100644 blob ${fileOid}\tpwned.txt\n`);
		const root = plumb(
			["mktree", "--missing"],
			`120000 blob ${linkOid}\tlink\n040000 tree ${subtree}\tlink\n`,
		);
		const sha = plumb(["commit-tree", root, "-m", "evil"], "");
		expect(raw(repo, ["ls-tree", "-r", "--name-only", sha])).toContain("link/pwned.txt");
		expect(git.snapshot(repo, sha, join(makeTempDir(), "snap"))).toMatchObject({
			ok: false,
			error: { code: "git_failed" },
		});
		expect(existsSync(join(outside, "pwned.txt"))).toBe(false);
	});

	it("rejects a malformed sha", () => {
		const { repo, git } = setup();
		expect(git.snapshot(repo, "--all", join(makeTempDir(), "snap"))).toMatchObject({
			ok: false,
			error: { code: "invalid_git_name" },
		});
	});
});

describe("merge lock atomic takeover", () => {
	const deadPid = () =>
		spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
			encoding: "utf8",
		}).stdout;

	it("release only removes the lock it still owns", () => {
		const dir = makeTempDir();
		const path = join(dir, "r.lock");
		const mine = acquireLock(path);
		if (!mine.ok) throw new Error("not acquired");
		writeFileSync(path, `${process.pid}:someone-else`);
		mine.value.release();
		expect(readFileSync(path, "utf8")).toBe(`${process.pid}:someone-else`);
	});

	it("lets exactly one of two contenders take over a stale lock, even when they interleave", () => {
		const dir = makeTempDir();
		const path = join(dir, "r.lock");
		writeFileSync(path, `${deadPid()}:stale`);
		let inner: ReturnType<typeof acquireLock> | undefined;
		const outer = acquireLock(path, {
			afterStaleObserved: () => {
				inner = acquireLock(path);
			},
		});
		expect(inner?.ok).toBe(true);
		expect(outer).toMatchObject({ ok: false, error: { code: "lock_held" } });
		expect(readFileSync(path, "utf8").split(":")[0]).toBe(String(process.pid));
		if (inner?.ok) {
			inner.value.release();
			expect(existsSync(path)).toBe(false);
		}
	});

	it("leaves no temporary or tombstone files behind", () => {
		const dir = makeTempDir();
		const path = join(dir, "r.lock");
		writeFileSync(path, `${deadPid()}:stale`);
		const taken = acquireLock(path);
		expect(taken.ok).toBe(true);
		if (taken.ok) taken.value.release();
		expect(readdirSync(dir)).toEqual([]);
	});
});
