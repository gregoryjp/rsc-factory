import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { BUDGET_CONFIG_PATH } from "../../src/contracts/budget.js";
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
import type { FactoryFiles } from "../../src/modules/planning/ports.js";
import { sha256Of } from "../../src/shared/hash.js";
import { ok } from "../../src/shared/result.js";
import { createFakeClock, type FakeClock } from "./clock.js";

export const REPO_ROOT = join(import.meta.dirname, "..", "..");

const TEST_BUDGET_CONFIG = JSON.stringify({
	defaultRunBudgetUsd: 15,
	maxCallUsd: {
		"spec-writer": 1.5,
		architect: 1.5,
		planner: 1.5,
		builder: 3,
		"reviewer-security": 1.5,
		"reviewer-code": 1.5,
		"reviewer-ux": 1.5,
		"reviewer-ui": 1.5,
		"reviewer-legal": 1.5,
		"review-refuter": 1.5,
		approver: 1,
	},
	retry: { maxAttempts: 3, baseMs: 2000, capMs: 60_000 },
});

export const withTestBudgetConfig = (files: FactoryFiles): FactoryFiles => ({
	read: (relativePath) =>
		relativePath === BUDGET_CONFIG_PATH
			? ok({ content: TEST_BUDGET_CONFIG, sha256: sha256Of(TEST_BUDGET_CONFIG) })
			: files.read(relativePath),
});

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
		factoryFiles: withTestBudgetConfig(createFsFactoryFiles({ repoRoot: REPO_ROOT })),
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
