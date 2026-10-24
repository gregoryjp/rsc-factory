import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { createFsArtifactStore } from "../../src/infrastructure/fs/artifact-store.js";
import { createFsFactoryFiles } from "../../src/infrastructure/fs/factory-files.js";
import { createFsPrdFiles } from "../../src/infrastructure/fs/prd-files.js";
import { createFsTargetFiles } from "../../src/infrastructure/fs/target-files.js";
import type { IdGenerator } from "../../src/infrastructure/ids.js";
import {
	createScriptedProvider,
	type ScriptedProvider,
} from "../../src/infrastructure/providers/scripted-provider.js";
import { openStorage } from "../../src/infrastructure/storage/sqlite-storage.js";
import { createFakeClock, type FakeClock } from "./clock.js";

export const REPO_ROOT = join(import.meta.dirname, "..", "..");

export const createSequentialIds = (): IdGenerator => {
	let counter = 0;
	return (prefix) => {
		counter += 1;
		return `${prefix}_${counter}`;
	};
};

const tempDirs: string[] = [];

export const makeTempDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "factory-test-"));
	tempDirs.push(dir);
	return dir;
};

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export const openEnv = (
	home: string,
	clock: FakeClock = createFakeClock(),
	options: { provider?: ScriptedProvider; contextPackMaxBytes?: number } = {},
) => {
	const storage = openStorage({ file: join(home, "factory.db") });
	return {
		storage,
		clock,
		ids: createSequentialIds(),
		prdFiles: createFsPrdFiles({ factoryHome: home }),
		targets: createFsTargetFiles({ repoRoot: REPO_ROOT, factoryHome: home }),
		factoryHome: home,
		provider: options.provider ?? createScriptedProvider({}),
		artifactStore: createFsArtifactStore({ factoryHome: home }),
		factoryFiles: createFsFactoryFiles({ repoRoot: REPO_ROOT }),
		settings: {
			contextPackMaxBytes: options.contextPackMaxBytes ?? 60 * 1024,
			factoryHome: home,
			providerKind: "fake" as const,
		},
	};
};

export type TestEnv = ReturnType<typeof openEnv>;

export const createEnv = (): TestEnv => openEnv(makeTempDir());

export const writePrd = (dir: string, content = "# PRD\n\nBuild a thing.\n"): string => {
	const path = join(dir, `prd-${Math.random().toString(36).slice(2)}.md`);
	writeFileSync(path, content);
	return path;
};
