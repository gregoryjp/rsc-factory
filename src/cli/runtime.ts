import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { NODE_IMAGE, PLAYWRIGHT_IMAGE, POSTGRES_IMAGE } from "../config/compatibility.js";
import type { Config } from "../config/env.js";
import { RoleSchema } from "../contracts/planning.js";
import { toProductName, toProductSlug } from "../domain/templates/render.js";
import { systemClock } from "../infrastructure/clock.js";
import { createFsArtifactStore } from "../infrastructure/fs/artifact-store.js";
import { createFsFactoryFiles } from "../infrastructure/fs/factory-files.js";
import { createFsPrdFiles } from "../infrastructure/fs/prd-files.js";
import { createFsTargetFiles } from "../infrastructure/fs/target-files.js";
import { createFsTargetWriter } from "../infrastructure/fs/target-writer.js";
import { createFsTemplateStore } from "../infrastructure/fs/template-store.js";
import { createGit } from "../infrastructure/git/git.js";
import { createReadOnlyGit } from "../infrastructure/git/read-only-git.js";
import { uuidIds } from "../infrastructure/ids.js";
import { execCommand } from "../infrastructure/process.js";
import { createClaudeCliProvider } from "../infrastructure/providers/claude-cli-provider.js";
import { createCodexCliProvider } from "../infrastructure/providers/codex-cli-provider.js";
import type { ProviderPort } from "../infrastructure/providers/provider-port.js";
import { createRoutingProvider } from "../infrastructure/providers/routing-provider.js";
import {
	createScriptedProvider,
	loadFixtureScripts,
} from "../infrastructure/providers/scripted-provider.js";
import { createDockerExec } from "../infrastructure/runner/docker-cli.js";
import { createDockerPreview } from "../infrastructure/runner/docker-preview.js";
import { createDockerRunner } from "../infrastructure/runner/docker-runner.js";
import { createHostRunner } from "../infrastructure/runner/host-runner.js";
import { containerUserFor, selectRunner } from "../infrastructure/runner/select-runner.js";
import { openStorage } from "../infrastructure/storage/sqlite-storage.js";
import type { AuditDeps } from "../modules/audit/audit-repo.js";
import type { ReleaseDeps } from "../modules/delivery/release.js";
import type { AppDeps } from "../modules/deps.js";
import type { BuildRunDeps } from "../modules/execution/build-run.js";
import type { PlanDeps } from "../modules/planning/deps.js";
import type { PrdFiles, TargetFiles } from "../modules/runs/ports.js";
import { type Failure, fail, ok, type Result } from "../shared/result.js";

export type Runtime = {
	deps: AppDeps & { prdFiles: PrdFiles; targets: TargetFiles };
	planDeps: () => Result<PlanDeps, Failure>;
	releaseDeps: () => ReleaseDeps;
	auditDeps: (
		targetPath: string,
	) => Promise<Result<{ deps: AuditDeps; warning: string | null }, Failure>>;
	buildDeps: (
		runId: string,
	) => Promise<Result<{ deps: BuildRunDeps; warning: string | null }, Failure>>;
	close: () => void;
};

const OPTIONAL_FIXTURE_ROLES: readonly string[] = [
	"builder",
	"reviewer-security",
	"reviewer-code",
	"reviewer-ux",
	"reviewer-ui",
	"reviewer-legal",
	"review-refuter",
	"approver",
];

const createProvider = (config: Config): Result<ProviderPort, Failure> => {
	if (config.provider.kind === "claude") {
		return ok(
			createRoutingProvider({
				claude: createClaudeCliProvider({ binaryPath: config.claudeBin }),
				codex: createCodexCliProvider({
					binaryPath: config.codexBin,
					authFile: join(config.codexHome, "auth.json"),
					workDir: join(config.factoryHome, "codex-calls"),
					env: config.subprocessEnv,
				}),
			}),
		);
	}
	const scripts = loadFixtureScripts(
		config.provider.fixturesDir,
		RoleSchema.options.filter((role) => !OPTIONAL_FIXTURE_ROLES.includes(role)),
		OPTIONAL_FIXTURE_ROLES,
	);
	return scripts.ok ? ok(createScriptedProvider(scripts.value)) : scripts;
};

export const openRuntime = (config: Config): Runtime => {
	mkdirSync(config.factoryHome, { recursive: true });
	const storage = openStorage({ file: config.dbFile });
	const base = {
		storage,
		clock: systemClock,
		ids: uuidIds,
	};
	const deps = {
		...base,
		prdFiles: createFsPrdFiles({ factoryHome: config.factoryHome }),
		targets: createFsTargetFiles({
			repoRoot: config.repoRoot,
			factoryHome: config.factoryHome,
		}),
	};
	const chooseRunner = async (slug: string) => {
		const now = () => Date.now();
		const hostUser = { uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 };
		let containerUser = hostUser;
		const selected = await selectRunner({
			preference: config.runnerPreference,
			exec: execCommand,
			makeHost: () =>
				createHostRunner({
					factoryHome: config.factoryHome,
					baseEnv: config.subprocessEnv,
					ids: uuidIds,
					now,
				}),
			makeDocker: (dockerOs) => {
				containerUser = containerUserFor(dockerOs, hostUser);
				return createDockerRunner({
					factoryHome: config.factoryHome,
					dockerBin: "docker",
					baseEnv: config.subprocessEnv,
					nodeImage: NODE_IMAGE,
					postgresImage: POSTGRES_IMAGE,
					user: containerUser,
					homeDir: homedir(),
					slug,
					ids: uuidIds,
					now,
					readyTimeoutMs: 90_000,
				});
			},
		});
		return selected.ok
			? ok({ runner: selected.value.runner, warning: selected.value.warning, containerUser })
			: selected;
	};
	const runtime: Runtime = {
		deps,
		planDeps: () => {
			const provider = createProvider(config);
			if (!provider.ok) return provider;
			return ok({
				...base,
				provider: provider.value,
				artifactStore: createFsArtifactStore({ factoryHome: config.factoryHome }),
				factoryFiles: createFsFactoryFiles({ repoRoot: config.repoRoot }),
				settings: {
					contextPackMaxBytes: config.contextPackMaxBytes,
					factoryHome: config.factoryHome,
					providerKind: config.provider.kind,
				},
			});
		},
		releaseDeps: () => ({
			...base,
			artifactStore: createFsArtifactStore({ factoryHome: config.factoryHome }),
			factoryFiles: createFsFactoryFiles({ repoRoot: config.repoRoot }),
			settings: {
				contextPackMaxBytes: config.contextPackMaxBytes,
				factoryHome: config.factoryHome,
				providerKind: config.provider.kind,
			},
		}),
		auditDeps: async (targetPath) => {
			const slug = toProductSlug(toProductName(basename(targetPath)));
			const selected = await chooseRunner(slug);
			if (!selected.ok) return selected;
			const planDeps = runtime.planDeps();
			if (!planDeps.ok) return planDeps;
			return ok({
				deps: {
					...planDeps.value,
					git: createReadOnlyGit({
						factoryHome: config.factoryHome,
						baseEnv: config.subprocessEnv,
					}),
					runner: selected.value.runner,
				},
				warning: selected.value.warning,
			});
		},
		buildDeps: async (runId) => {
			const run = storage.runs.get(runId);
			if (!run) return fail("run_not_found", `Run ${runId} not found`);
			const project = storage.projects.findById(run.projectId);
			const slug = toProductSlug(toProductName(project?.name ?? ""));
			const selected = await chooseRunner(slug);
			if (!selected.ok) return selected;
			const { containerUser } = selected.value;
			const preview =
				selected.value.runner.kind === "docker"
					? createDockerPreview({
							factoryHome: config.factoryHome,
							exec: createDockerExec({ dockerBin: "docker", baseEnv: config.subprocessEnv }),
							toolsSource: join(config.repoRoot, "factory", "preview"),
							nodeImage: NODE_IMAGE,
							postgresImage: POSTGRES_IMAGE,
							playwrightImage: PLAYWRIGHT_IMAGE,
							user: containerUser,
							homeDir: homedir(),
						})
					: undefined;
			const planDeps = runtime.planDeps();
			if (!planDeps.ok) return planDeps;
			return ok({
				deps: {
					...base,
					provider: planDeps.value.provider,
					factoryFiles: planDeps.value.factoryFiles,
					settings: planDeps.value.settings,
					targets: deps.targets,
					templates: createFsTemplateStore({ repoRoot: config.repoRoot }),
					writer: createFsTargetWriter(),
					git: createGit({ factoryHome: config.factoryHome, baseEnv: config.subprocessEnv }),
					artifactStore: createFsArtifactStore({ factoryHome: config.factoryHome }),
					runner: selected.value.runner,
					...(preview ? { preview } : {}),
					factoryHome: config.factoryHome,
				},
				warning: selected.value.warning,
			});
		},
		close: () => storage.close(),
	};
	return runtime;
};
