import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CODEX_IMAGE } from "../../src/config/compatibility.js";
import { createGit } from "../../src/infrastructure/git/git.js";
import {
	buildCodexCleanupArgvs,
	buildCodexNetworkCreateArgv,
	buildCodexRunArgv,
	findCodexVendorDir,
} from "../../src/infrastructure/providers/codex-docker.js";
import type { GitPort } from "../../src/modules/execution/ports.js";
import { commitAll } from "../helpers/exec-env.js";
import {
	baseEnv,
	containerUser,
	dockerAvailable,
	labeled,
	makeHomeTempDir,
	SKIP_REASON,
} from "./docker-helpers.js";

const RUN_ID = "run_cdxbuild";
const vendor = findCodexVendorDir("codex", process.env.PATH);
const FORBIDDEN_ROOTS = [join(homedir(), ".ssh"), join(homedir(), ".codex")];

const value = <T>(
	result: { ok: true; value: T } | { ok: false; error: { message: string } },
): T => {
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
};

const sh = (args: readonly string[]) => spawnSync("docker", [...args], { encoding: "utf8" });

const gitdirOf = (worktree: string): string =>
	readFileSync(join(worktree, ".git"), "utf8").trim().slice("gitdir:".length).trim();

const setup = () => {
	const factoryHome = makeHomeTempDir();
	const repo = makeHomeTempDir();
	const git: GitPort = createGit({ factoryHome, baseEnv: baseEnv() });
	value(git.init(repo, "main"));
	value(git.configureIdentity(repo, "Factory Test", "factory@localhost"));
	writeFileSync(join(repo, "a.txt"), "a");
	const base = value(commitAll(git, repo, "chore: base"));
	value(git.checkoutBranch({ repoDir: repo, branch: "factory/integration", createFromSha: base }));
	const { path } = value(
		git.worktreeAdd({
			repoDir: repo,
			runId: RUN_ID,
			taskKey: "t1",
			branch: "factory/t1",
			baseSha: base,
		}),
	);
	return { git, repo, base, worktree: path };
};

const runBuilderContainer = (callId: string, worktree: string, script: string) => {
	if (!vendor.ok) throw new Error(vendor.error.message);
	const home = makeHomeTempDir();
	const schema = join(home, "schema.json");
	writeFileSync(schema, "{}");
	const homeDir = join(home, "codex-home");
	mkdirSync(homeDir);
	writeFileSync(join(homeDir, "auth.json"), '{"copy":true}');
	const built = buildCodexRunArgv({
		runId: RUN_ID,
		callId,
		image: CODEX_IMAGE,
		vendorDir: vendor.value,
		homeDir,
		schemaFile: schema,
		workspace: worktree,
		writableWorkspace: true,
		user: containerUser,
		hostHome: homedir(),
		forbiddenRoots: FORBIDDEN_ROOTS,
		env: {},
		codexArgs: [],
	});
	if (!built.ok) throw new Error(built.error.message);
	const argv = [...built.value.slice(0, built.value.indexOf(CODEX_IMAGE) + 1), "-c", script];
	expect(sh(buildCodexNetworkCreateArgv(RUN_ID, callId)).status).toBe(0);
	const ran = sh(argv);
	for (const cleanup of buildCodexCleanupArgvs(RUN_ID, callId)) sh(cleanup);
	return ran;
};

afterEach(() => {
	if (!dockerAvailable) return;
	for (const name of labeled("ps", RUN_ID)) sh(["rm", "-f", name]);
	for (const name of labeled("network", RUN_ID)) sh(["network", "rm", name]);
});

describe.skipIf(!dockerAvailable || !vendor.ok)(
	`codex builder fallback confinement${dockerAvailable ? "" : ` (${SKIP_REASON})`}`,
	() => {
		it("confines writes to the worktree and leaves the repository and its gitdir untouched", () => {
			const t = setup();
			const hostGitdir = gitdirOf(t.worktree);
			const headBefore = value(t.git.headSha(t.repo));
			const script = [
				"echo new > /workspace/new.txt && echo worktree=writable || echo worktree=readonly",
				"mkdir -p /workspace/deep/dir && echo deep > /workspace/deep/dir/f.txt && echo deepwrite=ok || echo deepwrite=blocked",
				`[ -e ${t.repo} ] && echo repo=visible || echo repo=absent`,
				`[ -e ${hostGitdir} ] && echo gitdir=visible || echo gitdir=absent`,
				`touch ${t.repo}/escape.txt 2>/dev/null && echo repowrite=ok || echo repowrite=blocked`,
				"touch /etc/probe 2>/dev/null && echo rootfs=writable || echo rootfs=readonly",
				"touch /opt/codex/probe 2>/dev/null && echo codex=writable || echo codex=readonly",
				"touch /escape.txt 2>/dev/null && echo parent=writable || echo parent=readonly",
				"touch /input/probe 2>/dev/null && echo input=writable || echo input=readonly",
				`[ -e ${homedir()}/.ssh ] && echo ssh=visible || echo ssh=absent`,
				"command -v git >/dev/null 2>&1 && echo git=present || echo git=absent",
			].join("; ");
			const ran = runBuilderContainer("b1", t.worktree, script);
			expect(ran.status).toBe(0);
			const out = ran.stdout;
			expect(out).toContain("worktree=writable");
			expect(out).toContain("deepwrite=ok");
			expect(out).toContain("repo=absent");
			expect(out).toContain("gitdir=absent");
			expect(out).toContain("repowrite=blocked");
			expect(out).toContain("rootfs=readonly");
			expect(out).toContain("codex=readonly");
			expect(out).toContain("parent=readonly");
			expect(out).toContain("input=readonly");
			expect(out).toContain("ssh=absent");
			expect(out).toContain("git=absent");
			expect(readFileSync(join(t.worktree, "new.txt"), "utf8").trim()).toBe("new");
			expect(existsSync(join(t.repo, "escape.txt"))).toBe(false);
			expect(value(t.git.headSha(t.repo))).toBe(headBefore);
			expect(value(t.git.branchHead(t.repo, "factory/t1"))).toBe(t.base);
			expect(existsSync(join(hostGitdir, "escape.txt"))).toBe(false);
		});

		it("keeps commits engine-only: the container cannot commit and the engine commits what it wrote", () => {
			const t = setup();
			const ran = runBuilderContainer(
				"b2",
				t.worktree,
				"echo feature > /workspace/feature.txt; cat /workspace/.git",
			);
			expect(ran.status).toBe(0);
			expect(ran.stdout).toContain(`gitdir: ${gitdirOf(t.worktree)}`);
			expect(value(t.git.branchHead(t.repo, "factory/t1"))).toBe(t.base);
			const committed = value(commitAll(t.git, t.worktree, "feat: engine commit"));
			expect(committed).not.toBe(t.base);
			expect(value(t.git.branchHead(t.repo, "factory/t1"))).toBe(committed);
			expect(value(t.git.showFile(t.worktree, committed, "feature.txt"))?.trim()).toBe("feature");
		});

		it("detects a container that rewrites the .git pointer (worktree_pointer_tampered)", () => {
			const t = setup();
			const ran = runBuilderContainer(
				"b3",
				t.worktree,
				"printf 'gitdir: /workspace/.evil\\n' > /workspace/.git; mkdir -p /workspace/.evil",
			);
			expect(ran.status).toBe(0);
			const status = t.git.statusPorcelainV2(t.worktree);
			expect(status).toMatchObject({ ok: false, error: { code: "worktree_pointer_tampered" } });
			expect(value(t.git.branchHead(t.repo, "factory/t1"))).toBe(t.base);
		});

		it("leaves no labeled containers or networks behind", () => {
			const t = setup();
			runBuilderContainer("b4", t.worktree, "exit 3");
			expect(labeled("ps", RUN_ID)).toEqual([]);
			expect(labeled("network", RUN_ID)).toEqual([]);
		});
	},
);
