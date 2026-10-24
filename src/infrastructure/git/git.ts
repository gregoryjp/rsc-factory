import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";
import type { ChangeStatus } from "../../domain/builder/protected-changes.js";
import {
	isCommitSha,
	parseBranchName,
	parseCommitRef,
	parseGitName,
} from "../../domain/git/names.js";
import { isValidRunId } from "../../domain/ids/run-id.js";
import type { ScanFile } from "../../domain/security/secret-scan.js";
import type { GitError, GitPort } from "../../modules/execution/ports.js";
import { fail, ok, type Result } from "../../shared/result.js";
import { acquireLock } from "./lock.js";

const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 1024 * 1024 * 1024;
const DIFF_ARGS = ["diff", "--no-ext-diff", "--no-textconv", "--no-color"] as const;

const SAFE_CONFIG = [
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"commit.gpgsign=false",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.untrackedCache=false",
	"-c",
	"core.pager=cat",
	"-c",
	"diff.external=",
	"-c",
	"core.sshCommand=",
	"-c",
	"protocol.allow=never",
];

const isSafeTreePath = (path: string): boolean =>
	path !== "" &&
	path
		.split("/")
		.every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git");

const symlinkEscapes = (entryPath: string, target: string): boolean => {
	if (target === "" || target.includes("\0") || isAbsolute(target) || target.startsWith("/")) {
		return true;
	}
	const resolved = posix.normalize(posix.join(posix.dirname(entryPath), target));
	return resolved === ".." || resolved.startsWith("../") || resolved.startsWith("/");
};

const hasNestedEntryConflict = (paths: readonly string[]): boolean => {
	const entries = new Set(paths);
	return paths.some((path) => {
		const parts = path.split("/");
		return parts.slice(1).some((_, index) => entries.has(parts.slice(0, index + 1).join("/")));
	});
};

const sha256 = (content: Buffer | string): string =>
	createHash("sha256").update(content).digest("hex");

const digestOf = (path: string): string => {
	try {
		return sha256(readFileSync(path));
	} catch {
		return "absent";
	}
};

type GitContext = { gitDir: string; workTree: string; common: string };

type Raw = { status: number | null; stdout: string; stderr: string };

export const createGit = (config: {
	factoryHome: string;
	baseEnv: Readonly<Record<string, string>>;
	unsealed?: boolean;
}): GitPort => {
	const env = {
		...config.baseEnv,
		GIT_OPTIONAL_LOCKS: "0",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_ATTR_NOSYSTEM: "1",
		LC_ALL: "C",
	};

	const registryFile = (dir: string): string =>
		join(config.factoryHome, "worktree-registry", sha256(resolve(dir)));

	const commonOf = (gitDir: string): string => {
		try {
			return resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());
		} catch {
			return gitDir;
		}
	};

	const resolveContext = (dir: string): Result<GitContext, GitError> => {
		const workTree = resolve(dir);
		const dotGit = join(workTree, ".git");
		let expected: string | undefined;
		try {
			expected = readFileSync(registryFile(workTree), "utf8").trim();
		} catch {
			expected = undefined;
		}
		try {
			const stat = lstatSync(dotGit);
			if (expected === undefined) {
				return stat.isDirectory()
					? ok({ gitDir: dotGit, workTree, common: dotGit })
					: fail("worktree_pointer_tampered", `${dotGit} is not a repository directory`);
			}
			const intact = stat.isFile() && readFileSync(dotGit, "utf8").trim() === `gitdir: ${expected}`;
			return intact
				? ok({ gitDir: expected, workTree, common: commonOf(expected) })
				: fail(
						"worktree_pointer_tampered",
						`${dotGit} no longer points at the engine-managed worktree gitdir`,
					);
		} catch {
			return fail("git_failed", `${dir} is not a git repository`);
		}
	};

	const registerWorktree = (path: string, repoDir: string): Result<void, GitError> => {
		try {
			const pointer = readFileSync(join(path, ".git"), "utf8").trim();
			const gitDir = resolve(path, pointer.slice("gitdir:".length).trim());
			const parent = resolve(repoDir, ".git", "worktrees");
			if (!pointer.startsWith("gitdir:") || dirname(gitDir) !== parent) {
				return fail("worktree_pointer_tampered", `Unexpected worktree gitdir for ${path}`);
			}
			mkdirSync(dirname(registryFile(path)), { recursive: true });
			writeFileSync(registryFile(path), gitDir);
			return ok(undefined);
		} catch (cause) {
			const reason = cause instanceof Error ? cause.message : "unknown error";
			return fail("git_failed", `Could not register worktree ${path}: ${reason}`);
		}
	};

	const sealFile = (common: string): string =>
		join(config.factoryHome, "repo-seals", sha256(realpathSync(common)));

	const sealDigest = (common: string): string =>
		`${digestOf(join(common, "config"))}|${digestOf(join(common, "info", "attributes"))}`;

	const sealRepo = (dir: string, expectedFingerprint?: string): Result<void, GitError> => {
		const context = resolveContext(dir);
		if (!context.ok) return context;
		const gitDir = context.value.common;
		if (expectedFingerprint !== undefined && sealDigest(gitDir) !== expectedFingerprint) {
			return fail(
				"repo_config_tampered",
				`.git/config or .git/info/attributes of ${dir} differ from the staged repository`,
			);
		}
		try {
			const file = sealFile(gitDir);
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, sealDigest(gitDir));
			return ok(undefined);
		} catch (cause) {
			const reason = cause instanceof Error ? cause.message : "unknown error";
			return fail("git_failed", `Could not seal ${dir}: ${reason}`);
		}
	};

	const verifySeal = (dir: string, context: GitContext): Result<void, GitError> => {
		let sealed: string;
		try {
			sealed = readFileSync(sealFile(context.common), "utf8");
		} catch {
			return fail("repo_not_sealed", `${dir} has no engine seal; refusing to run git`);
		}
		return sealed === sealDigest(context.common)
			? ok(undefined)
			: fail(
					"repo_config_tampered",
					`.git/config or .git/info/attributes of ${dir} changed since the engine sealed it; refusing to run git`,
				);
	};

	const envFor = (context: GitContext | undefined) =>
		context === undefined
			? env
			: { ...env, GIT_DIR: context.gitDir, GIT_WORK_TREE: context.workTree };

	const exec = (
		cwd: string,
		args: readonly string[],
		options: { skipSeal?: boolean; bootstrap?: boolean } = {},
	): Result<Raw, GitError> => {
		let context: GitContext | undefined;
		if (options.bootstrap !== true) {
			const resolved = resolveContext(cwd);
			if (!resolved.ok) return resolved;
			context = resolved.value;
			if (options.skipSeal !== true && config.unsealed !== true) {
				const verified = verifySeal(cwd, context);
				if (!verified.ok) return verified;
			}
		}
		const spawned = spawnSync("git", [...SAFE_CONFIG, ...args], {
			cwd,
			env: envFor(context),
			encoding: "utf8",
			maxBuffer: MAX_BUFFER_BYTES,
		});
		if (spawned.error) return fail("git_failed", `git could not run: ${spawned.error.message}`);
		return ok({ status: spawned.status, stdout: spawned.stdout, stderr: spawned.stderr });
	};

	const run = (
		cwd: string,
		args: readonly string[],
		options: { skipSeal?: boolean; bootstrap?: boolean } = {},
	): Result<string, GitError> => {
		const raw = exec(cwd, args, options);
		if (!raw.ok) return raw;
		if (raw.value.status !== 0) {
			const reason = raw.value.stderr.trim().split("\n")[0] ?? "";
			return fail(
				"git_failed",
				`git ${args[0] ?? ""} failed (exit ${raw.value.status}): ${reason}`,
			);
		}
		return ok(raw.value.stdout);
	};

	const readBlobs = (repoDir: string, oids: readonly string[]): Result<Buffer[], GitError> => {
		if (oids.length === 0) return ok([]);
		const context = resolveContext(repoDir);
		if (!context.ok) return context;
		const spawned = spawnSync("git", [...SAFE_CONFIG, "cat-file", "--batch"], {
			cwd: repoDir,
			env: envFor(context.value),
			input: `${oids.join("\n")}\n`,
			maxBuffer: MAX_SNAPSHOT_BYTES,
		});
		if (spawned.error || spawned.status !== 0) return fail("git_failed", "git cat-file failed");
		const out = spawned.stdout;
		const blobs: Buffer[] = [];
		let offset = 0;
		for (let i = 0; i < oids.length; i += 1) {
			const newline = out.indexOf(0x0a, offset);
			if (newline === -1) return fail("git_failed", "Malformed cat-file output");
			const size = Number.parseInt(
				out.subarray(offset, newline).toString("utf8").split(" ")[2] ?? "",
				10,
			);
			if (!Number.isInteger(size)) return fail("git_failed", "Malformed cat-file header");
			blobs.push(out.subarray(newline + 1, newline + 1 + size));
			offset = newline + 1 + size + 1;
		}
		return ok(blobs);
	};

	const lockPath = (id: string): string => join(config.factoryHome, "locks", `${id}.merge.lock`);

	const underLock = <T>(
		id: string,
		held: boolean | undefined,
		work: () => Result<T, GitError>,
	): Result<T, GitError> => {
		if (held === true) return work();
		const lock = acquireLock(lockPath(id));
		if (!lock.ok) return lock;
		try {
			return work();
		} finally {
			lock.value.release();
		}
	};

	const revPath = (rev: string, path: string): Result<string, GitError> => {
		const ref = parseCommitRef(rev);
		if (!ref.ok) return ref;
		if (!isSafeTreePath(path))
			return fail("invalid_git_name", `Unsafe path: ${JSON.stringify(path)}`);
		return ok(`${ref.value}:${path}`);
	};

	const runId = (value: string): Result<string, GitError> =>
		isValidRunId(value)
			? ok(value)
			: fail("invalid_git_name", `Invalid run id: ${JSON.stringify(value)}`);

	const worktreePath = (run: string, taskKey: string): Result<string, GitError> => {
		const id = runId(run);
		if (!id.ok) return id;
		const key = parseGitName(taskKey);
		if (!key.ok) return key;
		return ok(join(config.factoryHome, "runs", id.value, "worktrees", key.value));
	};

	const headSha = (dir: string): Result<string, GitError> => {
		const out = run(dir, ["rev-parse", "HEAD"]);
		return out.ok ? ok(out.value.trim()) : out;
	};

	const stageAll = (dir: string): Result<void, GitError> => {
		const out = run(dir, ["add", "-A"]);
		return out.ok ? ok(undefined) : out;
	};

	const commit = (dir: string, message: string): Result<string, GitError> => {
		if (message.trim() === "") return fail("git_failed", "Commit message must not be empty");
		const raw = exec(dir, ["commit", "--no-verify", "-q", "-m", message]);
		if (!raw.ok) return raw;
		if (raw.value.status !== 0) {
			const output = `${raw.value.stdout}${raw.value.stderr}`;
			return output.includes("nothing to commit") || output.includes("nothing added to commit")
				? fail("nothing_to_commit", "Nothing to commit")
				: fail("git_failed", `git commit failed (exit ${raw.value.status})`);
		}
		return headSha(dir);
	};

	const stagedFiles = (dir: string): Result<ScanFile[], GitError> => {
		const names = run(dir, ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"]);
		if (!names.ok) return names;
		const files: ScanFile[] = [];
		for (const path of names.value.split("\0").filter((name) => name !== "")) {
			const content = run(dir, ["show", `:${path}`]);
			if (!content.ok) return content;
			files.push({ path, content: content.value });
		}
		return ok(files);
	};

	return {
		init: (dir, branch) => {
			const name = parseGitName(branch);
			if (!name.ok) return name;
			const out = run(dir, ["init", "-q", "-b", name.value], { bootstrap: true });
			return out.ok ? sealRepo(dir) : out;
		},
		configureIdentity: (dir, name, email) => {
			const user = run(dir, ["config", "--local", "user.name", name]);
			if (!user.ok) return user;
			const mail = run(dir, ["config", "--local", "user.email", email], { skipSeal: true });
			return mail.ok ? sealRepo(dir) : mail;
		},
		sealRepo,
		fingerprint: (dir) => {
			const context = resolveContext(dir);
			return context.ok ? ok(sealDigest(context.value.common)) : context;
		},
		snapshot: (repoDir, sha, destDir) => {
			if (!isCommitSha(sha)) {
				return fail("invalid_git_name", `Invalid commit sha: ${JSON.stringify(sha)}`);
			}
			const listed = exec(repoDir, ["ls-tree", "-r", "-z", "--full-tree", sha]);
			if (!listed.ok) return listed;
			if (listed.value.status !== 0) return fail("git_failed", `git ls-tree ${sha} failed`);
			const entries = listed.value.stdout
				.split("\0")
				.filter((entry) => entry !== "")
				.map((entry) => {
					const tab = entry.indexOf("\t");
					const [mode = "", kind = "", oid = ""] = entry.slice(0, tab).split(" ");
					return { mode, kind, oid, path: entry.slice(tab + 1) };
				});
			const blobs = entries.filter((entry) => entry.kind === "blob");
			if (blobs.some((entry) => !isSafeTreePath(entry.path) || !/^[0-9a-f]{40}$/.test(entry.oid))) {
				return fail("git_failed", "The commit contains an unsafe path; refusing to snapshot it");
			}
			if (hasNestedEntryConflict(blobs.map((entry) => entry.path))) {
				return fail(
					"git_failed",
					"The commit nests an entry under another entry of the same name; refusing to snapshot it",
				);
			}
			const contents = readBlobs(
				repoDir,
				blobs.map((entry) => entry.oid),
			);
			if (!contents.ok) return contents;
			const unsafeLink = blobs.find(
				(entry, index) =>
					entry.mode === "120000" &&
					symlinkEscapes(entry.path, (contents.value[index] ?? Buffer.alloc(0)).toString("utf8")),
			);
			if (unsafeLink) {
				return fail(
					"unsafe_symlink",
					`The commit contains a symlink that is absolute or escapes the snapshot root: ${unsafeLink.path}`,
				);
			}
			try {
				mkdirSync(destDir, { recursive: true });
				blobs.forEach((entry, index) => {
					const target = join(destDir, ...entry.path.split("/"));
					mkdirSync(dirname(target), { recursive: true });
					const content = contents.value[index] ?? Buffer.alloc(0);
					if (entry.mode === "120000") {
						symlinkSync(content.toString("utf8"), target);
					} else {
						writeFileSync(target, content, {
							flag: "wx",
							mode: entry.mode === "100755" ? 0o755 : 0o644,
						});
					}
				});
				return ok(undefined);
			} catch (cause) {
				const reason = cause instanceof Error ? cause.message : "unknown error";
				return fail("git_failed", `Could not write the snapshot: ${reason}`);
			}
		},
		stageAll,
		unstageAll: (dir) => {
			const hasHead = exec(dir, ["rev-parse", "--verify", "-q", "HEAD"]);
			if (!hasHead.ok) return hasHead;
			const out =
				hasHead.value.status === 0
					? run(dir, ["reset", "-q"])
					: run(dir, ["rm", "-r", "--cached", "-q", "--ignore-unmatch", "."]);
			return out.ok ? ok(undefined) : out;
		},
		stagedFiles,
		commit,
		headSha,
		remoteNames: (dir) => {
			const out = run(dir, ["remote"]);
			return out.ok ? ok(out.value.split("\n").filter((name) => name !== "")) : out;
		},
		statusPorcelainV2: (dir) =>
			run(dir, ["status", "--porcelain=v2", "--untracked-files=all", "-z"]),
		listFiles: (dir) => {
			const out = run(dir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
			return out.ok
				? ok([...new Set(out.value.split("\0").filter((name) => name !== ""))].sort())
				: out;
		},
		isClean: (dir) => {
			const out = run(dir, ["status", "--porcelain", "--untracked-files=all"]);
			return out.ok ? ok(out.value.trim() === "") : out;
		},
		commitExists: (dir, sha) => {
			if (!isCommitSha(sha)) return ok(false);
			const raw = exec(dir, ["cat-file", "-e", `${sha}^{commit}`]);
			return raw.ok ? ok(raw.value.status === 0) : raw;
		},
		worktreeAdd: (input) => {
			const path = worktreePath(input.runId, input.taskKey);
			if (!path.ok) return path;
			const branch = parseBranchName(input.branch);
			if (!branch.ok) return branch;
			const base = parseCommitRef(input.baseSha);
			if (!base.ok) return base;
			if (existsSync(path.value)) {
				return fail("worktree_exists", `Worktree already exists: ${path.value}`);
			}
			mkdirSync(dirname(path.value), { recursive: true });
			const out = run(input.repoDir, [
				"worktree",
				"add",
				"-q",
				"-b",
				branch.value,
				path.value,
				base.value,
			]);
			if (!out.ok) return out;
			const registered = registerWorktree(path.value, input.repoDir);
			if (!registered.ok) return registered;
			const resealed = sealRepo(input.repoDir);
			return resealed.ok ? ok({ path: path.value }) : resealed;
		},
		worktreeRemove: (input) => {
			const path = worktreePath(input.runId, input.taskKey);
			if (!path.ok) return path;
			const out = run(input.repoDir, ["worktree", "remove", "--force", path.value]);
			if (!out.ok) return out;
			try {
				unlinkSync(registryFile(path.value));
			} catch {
				void 0;
			}
			return sealRepo(input.repoDir);
		},
		restoreWorktree: (dir, sha) => {
			const target = parseCommitRef(sha);
			if (!target.ok) return target;
			const reset = run(dir, ["reset", "--hard", target.value]);
			if (!reset.ok) return reset;
			const cleaned = run(dir, ["clean", "-fd"]);
			return cleaned.ok ? ok(undefined) : cleaned;
		},
		diffText: (dir, base, head, maxBytes) => {
			const from = parseCommitRef(base);
			if (!from.ok) return from;
			const to = parseCommitRef(head);
			if (!to.ok) return to;
			const out = run(dir, [...DIFF_ARGS, from.value, to.value]);
			if (!out.ok) return out;
			const bytes = Buffer.byteLength(out.value);
			return bytes > maxBytes
				? fail("diff_too_large", `The diff is ${bytes} bytes; the review limit is ${maxBytes}`)
				: ok(out.value);
		},
		diffWorktree: (dir, base, maxBytes) => {
			const from = parseCommitRef(base);
			if (!from.ok) return from;
			const staged = stageAll(dir);
			if (!staged.ok) return staged;
			const out = run(dir, [...DIFF_ARGS, "--cached", from.value]);
			if (!out.ok) return out;
			const bytes = Buffer.byteLength(out.value);
			return ok(
				bytes > maxBytes
					? { text: Buffer.from(out.value).subarray(0, maxBytes).toString("utf8"), truncated: true }
					: { text: out.value, truncated: false },
			);
		},
		diffNames: (dir, base, head) => {
			const from = parseCommitRef(base);
			if (!from.ok) return from;
			const to = parseCommitRef(head);
			if (!to.ok) return to;
			const out = run(dir, ["diff", "--name-only", "-z", from.value, to.value]);
			return out.ok ? ok(out.value.split("\0").filter((name) => name !== "")) : out;
		},
		mergeNoFf: (input) => {
			const id = runId(input.runId);
			if (!id.ok) return id;
			const into = parseBranchName(input.into);
			if (!into.ok) return into;
			const from = parseBranchName(input.from);
			if (!from.ok) return from;
			return underLock(id.value, input.holdsLock, () => {
				const current = exec(input.repoDir, ["symbolic-ref", "--short", "-q", "HEAD"]);
				if (!current.ok) return current;
				if (current.value.stdout.trim() !== into.value) {
					return fail(
						"not_checked_out",
						`Branch ${into.value} is not checked out in the repository`,
					);
				}
				const message = input.message ?? `chore: merge ${from.value}`;
				const merged = exec(input.repoDir, [
					"merge",
					"--no-ff",
					"--no-verify",
					"-m",
					message,
					from.value,
				]);
				if (!merged.ok) return merged;
				if (merged.value.status !== 0) {
					run(input.repoDir, ["merge", "--abort"]);
					return fail(
						"merge_conflict",
						`Merging ${from.value} into ${into.value} did not apply cleanly`,
					);
				}
				return headSha(input.repoDir);
			});
		},
		resetBranch: (input) => {
			const id = runId(input.runId);
			if (!id.ok) return id;
			const branch = parseBranchName(input.branch);
			if (!branch.ok) return branch;
			const to = parseCommitRef(input.to);
			if (!to.ok) return to;
			return underLock(id.value, input.holdsLock, () => {
				const current = exec(input.repoDir, ["symbolic-ref", "--short", "-q", "HEAD"]);
				if (!current.ok) return current;
				if (current.value.stdout.trim() !== branch.value) {
					return fail(
						"not_checked_out",
						`Branch ${branch.value} is not checked out in the repository`,
					);
				}
				const reset = run(input.repoDir, ["reset", "--hard", "-q", to.value]);
				return reset.ok ? ok(undefined) : reset;
			});
		},
		withMergeLock: async (id, work) => {
			const valid = runId(id);
			if (!valid.ok) return valid;
			const lock = acquireLock(lockPath(valid.value));
			if (!lock.ok) return lock;
			try {
				return await work();
			} finally {
				lock.value.release();
			}
		},
		branchExists: (dir, branch) => {
			const name = parseBranchName(branch);
			if (!name.ok) return name;
			const raw = exec(dir, ["rev-parse", "--verify", "-q", `refs/heads/${name.value}`]);
			return raw.ok ? ok(raw.value.status === 0) : raw;
		},
		checkoutBranch: (input) => {
			const name = parseBranchName(input.branch);
			if (!name.ok) return name;
			const exists = exec(input.repoDir, [
				"rev-parse",
				"--verify",
				"-q",
				`refs/heads/${name.value}`,
			]);
			if (!exists.ok) return exists;
			if (exists.value.status === 0) {
				const out = run(input.repoDir, ["checkout", "-q", name.value]);
				return out.ok ? ok(undefined) : out;
			}
			if (input.createFromSha === undefined) {
				return fail("git_failed", `Branch ${name.value} does not exist`);
			}
			const from = parseCommitRef(input.createFromSha);
			if (!from.ok) return from;
			const out = run(input.repoDir, ["checkout", "-q", "-b", name.value, from.value]);
			if (!out.ok) return out;
			return sealRepo(input.repoDir);
		},
		statusEntries: (dir) => {
			const out = run(dir, [
				"status",
				"--porcelain=v1",
				"-z",
				"--untracked-files=all",
				"--no-renames",
			]);
			if (!out.ok) return out;
			return ok(
				out.value
					.split("\0")
					.filter((entry) => entry.length > 3)
					.map((entry) => {
						const code = entry.slice(0, 2);
						const path = entry.slice(3);
						const status: ChangeStatus = code.includes("D")
							? "deleted"
							: code.includes("?") || code.includes("A")
								? "added"
								: "modified";
						return { path, status };
					}),
			);
		},
		blobOid: (dir, rev, path) => {
			const target = revPath(rev, path);
			if (!target.ok) return target;
			const raw = exec(dir, ["rev-parse", "--verify", "-q", target.value]);
			if (!raw.ok) return raw;
			return ok(raw.value.status === 0 ? raw.value.stdout.trim() : null);
		},
		parentsOf: (dir, rev) => {
			const ref = parseCommitRef(rev);
			if (!ref.ok) return ref;
			const out = run(dir, ["rev-list", "--parents", "-n", "1", ref.value]);
			return out.ok ? ok(out.value.trim().split(" ").slice(1)) : out;
		},
		branchHead: (dir, branch) => {
			const name = parseBranchName(branch);
			if (!name.ok) return name;
			const raw = exec(dir, ["rev-parse", "--verify", "-q", `refs/heads/${name.value}`]);
			if (!raw.ok) return raw;
			return ok(raw.value.status === 0 ? raw.value.stdout.trim() : null);
		},
		showFile: (dir, rev, path) => {
			const target = revPath(rev, path);
			if (!target.ok) return target;
			const exists = exec(dir, ["cat-file", "-e", target.value]);
			if (!exists.ok) return exists;
			if (exists.value.status !== 0) return ok(null);
			return run(dir, ["show", target.value]);
		},
	};
};
