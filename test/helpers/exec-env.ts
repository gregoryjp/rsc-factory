import { join } from "node:path";
import { createFsTargetWriter } from "../../src/infrastructure/fs/target-writer.js";
import { createFsTemplateStore } from "../../src/infrastructure/fs/template-store.js";
import { createGit } from "../../src/infrastructure/git/git.js";
import type { BootstrapDeps } from "../../src/modules/execution/bootstrap-product.js";
import type { GitPort } from "../../src/modules/execution/ports.js";
import { commitGuarded } from "../../src/modules/execution/safe-commit.js";
import { startRun } from "../../src/modules/runs/start-run.js";
import { transitionRun } from "../../src/modules/runs/transition-run.js";
import { createEnv, makeTempDir, openEnv, REPO_ROOT, writePrd } from "./env.js";

export const gitEnv = { PATH: process.env.PATH ?? "" };

export const createExecEnv = (home?: string) => {
	const env = home === undefined ? createEnv() : openEnv(home);
	const git = createGit({ factoryHome: env.factoryHome, baseEnv: gitEnv });
	const deps: BootstrapDeps & { factoryHome: string } = {
		...env,
		templates: createFsTemplateStore({ repoRoot: REPO_ROOT }),
		writer: createFsTargetWriter(),
		git,
	};
	return { env, deps, git };
};

export const seedPlanningRun = (
	env: ReturnType<typeof createEnv>,
	options: { presetIds: string[]; target?: string; projectName?: string },
) => {
	const dir = makeTempDir();
	const target = options.target ?? join(makeTempDir(), "product");
	const started = startRun(env, {
		prdPath: writePrd(dir),
		targetPath: target,
		projectName: options.projectName ?? "turno-local",
		cwd: dir,
		forceNew: false,
		deliveryTarget: null,
	});
	if (!started.ok) throw new Error(started.error.message);
	const runId = started.value.run.id;
	env.storage.runs.setPresets(runId, options.presetIds);
	for (const to of ["INGESTING", "SPECIFYING", "PLANNING"] as const) {
		const moved = transitionRun(env, { runId, to });
		if (!moved.ok) throw new Error(moved.error.message);
	}
	return { runId, target: started.value.run.targetPath ?? target };
};

export const FULLSTACK = ["backend-express-kimmbo", "web-react-vite"];

export const commitAll = (git: GitPort, dir: string, message: string) =>
	commitGuarded(git, dir, message);
