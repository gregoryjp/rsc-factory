import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFsTargetFiles } from "../src/infrastructure/fs/target-files.js";
import { makeTempDir } from "./helpers/env.js";

const setup = () => {
	const base = makeTempDir();
	const repoRoot = join(base, "factory-repo");
	const home = join(base, "factory-home");
	const work = join(base, "work");
	for (const dir of [repoRoot, home, work]) mkdirSync(dir);
	return {
		base,
		repoRoot,
		home,
		work,
		targets: createFsTargetFiles({ repoRoot, factoryHome: home }),
	};
};

describe("target resolution (E13/E18)", () => {
	it("accepts a missing directory, an empty directory and an existing git repo", () => {
		const { work, targets } = setup();
		const missing = targets.resolve(join(work, "new", "deep"));
		expect(missing).toMatchObject({ ok: true, value: { kind: "new" } });
		mkdirSync(join(work, "empty"));
		expect(targets.resolve(join(work, "empty"))).toMatchObject({
			ok: true,
			value: { kind: "empty" },
		});
		mkdirSync(join(work, "repo", ".git"), { recursive: true });
		writeFileSync(join(work, "repo", "a.txt"), "x");
		expect(targets.resolve(join(work, "repo"))).toMatchObject({
			ok: true,
			value: { kind: "git_repo" },
		});
	});

	it("rejects a non-empty directory that is not a git repo", () => {
		const { work, targets } = setup();
		mkdirSync(join(work, "full"));
		writeFileSync(join(work, "full", "a.txt"), "x");
		expect(targets.resolve(join(work, "full"))).toMatchObject({
			ok: false,
			error: { code: "target_not_empty" },
		});
	});

	it("rejects a file target", () => {
		const { work, targets } = setup();
		writeFileSync(join(work, "file"), "x");
		expect(targets.resolve(join(work, "file"))).toMatchObject({
			ok: false,
			error: { code: "target_not_directory" },
		});
		expect(targets.resolve(join(work, "file", "child"))).toMatchObject({
			ok: false,
			error: { code: "target_not_directory" },
		});
	});

	it("rejects targets inside or equal to the factory repo and FACTORY_HOME", () => {
		const { repoRoot, home, targets } = setup();
		for (const path of [repoRoot, join(repoRoot, "src"), home, join(home, "runs", "x")]) {
			expect(targets.resolve(path), path).toMatchObject({
				ok: false,
				error: { code: "target_inside_factory" },
			});
		}
	});

	it("rejects a target that contains the factory repo or FACTORY_HOME", () => {
		const { base, targets } = setup();
		expect(targets.resolve(base)).toMatchObject({
			ok: false,
			error: { code: "target_inside_factory" },
		});
	});

	it("rejects symlinks and ancestor symlinks pointing into the factory", () => {
		const { repoRoot, home, work, targets } = setup();
		symlinkSync(repoRoot, join(work, "link-repo"));
		symlinkSync(home, join(work, "link-home"));
		for (const path of [
			join(work, "link-repo"),
			join(work, "link-repo", "newdir"),
			join(work, "link-home", "runs"),
		]) {
			expect(targets.resolve(path), path).toMatchObject({
				ok: false,
				error: { code: "target_inside_factory" },
			});
		}
	});

	it("rejects a dangling symlink whose destination is inside the factory", () => {
		const { repoRoot, work, targets } = setup();
		symlinkSync(join(repoRoot, "not-yet"), join(work, "dangling"));
		expect(targets.resolve(join(work, "dangling"))).toMatchObject({
			ok: false,
			error: { code: "target_inside_factory" },
		});
	});

	it("rejects the real factory repository root", () => {
		const { home } = setup();
		const targets = createFsTargetFiles({
			repoRoot: join(import.meta.dirname, ".."),
			factoryHome: home,
		});
		expect(targets.resolve(join(import.meta.dirname, "..", "x"))).toMatchObject({
			ok: false,
			error: { code: "target_inside_factory" },
		});
	});
});
