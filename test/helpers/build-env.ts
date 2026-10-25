import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ArchitectOutput,
	PlannedTask,
	PlannerOutput,
	SpecOutput,
} from "../../src/contracts/planning.js";
import type { ReviewArea } from "../../src/contracts/review.js";
import { createFsTargetWriter } from "../../src/infrastructure/fs/target-writer.js";
import { createFsTemplateStore } from "../../src/infrastructure/fs/template-store.js";
import { createGit } from "../../src/infrastructure/git/git.js";
import type { ScriptedResult } from "../../src/infrastructure/providers/fake-provider.js";
import type { FileEdits } from "../../src/infrastructure/providers/file-edits.js";
import type {
	ProviderPort,
	ProviderRequest,
} from "../../src/infrastructure/providers/provider-port.js";
import {
	createScriptedProvider,
	type ScriptedProvider,
} from "../../src/infrastructure/providers/scripted-provider.js";
import { createHostRunner } from "../../src/infrastructure/runner/host-runner.js";
import type { BuildRunDeps } from "../../src/modules/execution/build-run.js";
import type { CheckRunnerPort, GitPort, PreviewPort } from "../../src/modules/execution/ports.js";
import { commitGuarded } from "../../src/modules/execution/safe-commit.js";
import { planRun } from "../../src/modules/planning/plan-run.js";
import type { FactoryFiles } from "../../src/modules/planning/ports.js";
import { startRun } from "../../src/modules/runs/start-run.js";
import { ok } from "../../src/shared/result.js";
import { createFakeClock } from "./clock.js";
import { makeTempDir, openEnv, REPO_ROOT, writePrd } from "./env.js";
import { gitEnv } from "./exec-env.js";

export const NODE_TEMPLATE = "node-test";

const policyWith = (audit?: string[], sast?: string) => ({
	[NODE_TEMPLATE]: {
		install: [],
		test: ["node", "--test"],
		check: ["node", "--test"],
		...(audit ? { audit } : {}),
		...(sast ? { sast } : {}),
		preview: {
			install: ["true"],
			staticDir: "web",
			routesFile: "web/ui-routes.json",
			authFile: "web/ui-auth.json",
		},
	},
});
const NODE_POLICY = policyWith();

const good = (output: unknown): ScriptedResult => ({
	ok: true,
	value: { output, costUsd: null, models: ["fake"] },
});

export const completed = (
	edits: FileEdits,
	extra: Record<string, unknown> = {},
): ScriptedResult => ({
	ok: true,
	value: {
		output: {
			status: "completed",
			summary: "done",
			testFiles: Object.keys(edits.writes ?? {}),
			...extra,
		},
		costUsd: null,
		models: ["fake"],
	},
	edits,
});

export const blockedByBuilder = (): ScriptedResult =>
	good({ status: "blocked", summary: "cannot do it", testFiles: [] });

export const task = (
	key: string,
	dependsOn: string[] = [],
	requirementIds: string[] = ["REQ-001"],
): PlannedTask => ({
	key,
	title: `Task ${key}`,
	requirementIds,
	dependsOn,
	acceptance: [`${key} works`],
	risk: "low",
	expectedPaths: [`src/${key}.js`],
});

export const redTest = (key: string, body = `assert.equal(${key}(), 1)`): FileEdits => ({
	writes: {
		[`test/${key}.test.js`]: `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { ${key} } from "../src/${key}.js";\ntest("${key}", () => { ${body}; });\n`,
	},
});

export const greenImpl = (key: string, value = 1): FileEdits => ({
	writes: { [`src/${key}.js`]: `export const ${key} = () => ${value};\n` },
});

export type ReviewScripts = {
	security?: ScriptedResult[];
	code?: ScriptedResult[];
	ux?: ScriptedResult[];
	ui?: ScriptedResult[];
	legal?: ScriptedResult[];
	refuter?: ScriptedResult[];
	approver?: ScriptedResult[];
};

export type BuildEnvOptions = {
	tasks: PlannedTask[];
	builder: ScriptedResult[];
	reviewers?: ReviewScripts;
	preview?: PreviewPort;
	reviewHook?: (request: ProviderRequest, index: number) => void;
	hook?: (request: ProviderRequest, index: number) => void;
	wrapRunner?: (runner: CheckRunnerPort) => CheckRunnerPort;
	audit?: string[];
	sast?: string;
	files?: Record<string, string>;
	spec?: SpecOutput;
	template?: {
		home: string;
		target: string;
		presetIds: string[];
		projectName: string;
		runner: CheckRunnerPort;
	};
};

const DEFAULT_SPEC: SpecOutput = {
	requirements: [
		{ id: "REQ-001", text: "Do it", acceptance: ["Works"], priority: "must", sourceRef: "PRD" },
	],
	assumptions: [],
	contradictions: [],
	outOfScope: [],
	openQuestions: [],
};

const planScripts = (tasks: PlannedTask[], presetIds: string[], spec: SpecOutput) => {
	const architecture: ArchitectOutput = {
		presetIds,
		rationale: "Static",
		omitted: [],
		decisions: [],
	};
	const plan: PlannerOutput = { tasks };
	return { "spec-writer": [good(spec)], architect: [good(architecture)], planner: [good(plan)] };
};

const REVIEW_SCRIPT_KEYS: Record<string, keyof ReviewScripts> = {
	"reviewer-security": "security",
	"reviewer-code": "code",
	"reviewer-ux": "ux",
	"reviewer-ui": "ui",
	"reviewer-legal": "legal",
	"review-refuter": "refuter",
	approver: "approver",
};

const requiresReviewPathsIn = (prompt: string): string[] => {
	const match = /BEGIN_REQUIRES_REVIEW_[0-9a-f]+\n([\s\S]*?)\nEND_REQUIRES_REVIEW_/.exec(prompt);
	if (!match?.[1]) return [];
	const parsed: unknown = JSON.parse(match[1]);
	return Array.isArray(parsed) ? parsed.map((entry: { path: string }) => entry.path) : [];
};

const autoOutput = (request: ProviderRequest): unknown => {
	if (request.role === "reviewer-security") {
		return { area: "security", verdict: "pass", findings: [], requiresReviewAck: [] };
	}
	if (request.role === "reviewer-ux" || request.role === "reviewer-ui") {
		return {
			area: request.role === "reviewer-ux" ? "ux" : "ui",
			verdict: "pass",
			findings: [],
			requiresReviewAck: [],
		};
	}
	if (request.role === "reviewer-legal") {
		return { area: "legal", verdict: "pass", findings: [], requiresReviewAck: [] };
	}
	if (request.role === "reviewer-code") {
		return {
			area: "code",
			verdict: "pass",
			findings: [],
			requiresReviewAck: requiresReviewPathsIn(request.prompt).map((path) => ({
				path,
				decision: "ok",
				note: "reviewed",
			})),
		};
	}
	return { recommendation: "accept", repairTasks: [], notes: "" };
};

const hooked = (inner: ScriptedProvider, options: BuildEnvOptions): ScriptedProvider => ({
	calls: inner.calls,
	invoke: async (request, schema) => {
		const role = request.role ?? "";
		if (role === "builder") {
			options.hook?.(request, inner.calls.filter((c) => c.role === "builder").length);
		}
		const scriptKey = REVIEW_SCRIPT_KEYS[role];
		if (scriptKey !== undefined) {
			options.reviewHook?.(request, inner.calls.filter((c) => c.role === role).length);
			if (options.reviewers?.[scriptKey] === undefined && role !== "review-refuter") {
				inner.calls.push(request);
				const parsed = schema.safeParse(autoOutput(request));
				if (!parsed.success) throw new Error(parsed.error.message);
				return { ok: true, value: { output: parsed.data, costUsd: 0, models: ["fake"] } };
			}
		}
		return inner.invoke(request, schema);
	},
});

const seedNodeProduct = (
	git: GitPort,
	base: ReturnType<typeof openEnv>,
	input: { runId: string; target: string; home: string; files: Record<string, string> | undefined },
): string => {
	mkdirSync(input.target, { recursive: true });
	const initialized = git.init(input.target, "main");
	if (!initialized.ok) throw new Error(initialized.error.message);
	git.configureIdentity(input.target, "Factory Test", "factory@localhost");
	const files: Record<string, string> = {
		"package.json": JSON.stringify({
			name: "p",
			type: "module",
			scripts: { test: "node --test", check: "node --test" },
		}),
		"README.md": "product\n",
		...input.files,
	};
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(input.target, path, ".."), { recursive: true });
		writeFileSync(join(input.target, path), content);
	}
	const committed = commitGuarded(git, input.target, "chore: scaffold from node-test");
	if (!committed.ok) throw new Error(committed.error.message);
	base.storage.events.append({
		runId: input.runId,
		type: "product.bootstrapped",
		payload: {
			templateId: NODE_TEMPLATE,
			commitSha: committed.value,
			fileCount: Object.keys(files).length,
		},
		now: base.clock.now(),
	});
	return committed.value;
};

export const createBuildEnv = async (options: BuildEnvOptions) => {
	const home = options.template?.home ?? makeTempDir();
	const clock = createFakeClock();
	const inner = createScriptedProvider({
		...planScripts(
			options.tasks,
			options.template?.presetIds ?? ["static-landing"],
			options.spec ?? DEFAULT_SPEC,
		),
		builder: options.builder,
		"reviewer-security": options.reviewers?.security ?? [],
		"reviewer-code": options.reviewers?.code ?? [],
		"reviewer-ux": options.reviewers?.ux ?? [],
		"reviewer-ui": options.reviewers?.ui ?? [],
		"reviewer-legal": options.reviewers?.legal ?? [],
		"review-refuter": options.reviewers?.refuter ?? [],
		approver: options.reviewers?.approver ?? [],
	});
	const provider = hooked(inner, options);
	const base = openEnv(home, clock, { provider: inner });
	const factoryFiles: FactoryFiles = options.template
		? base.factoryFiles
		: {
				read: (path) =>
					path === "factory/policies/checks.json"
						? ok({
								content: JSON.stringify(policyWith(options.audit, options.sast)),
								sha256: "0".repeat(64),
							})
						: base.factoryFiles.read(path),
			};
	const target = options.template?.target ?? join(makeTempDir(), "product");
	const started = startRun(base, {
		prdPath: writePrd(home),
		targetPath: target,
		projectName: options.template?.projectName ?? "node-demo",
		cwd: home,
		forceNew: true,
		deliveryTarget: "local",
	});
	if (!started.ok) throw new Error(started.error.message);
	const runId = started.value.run.id;
	const planned = await planRun({ ...base, provider: inner }, { runId });
	if (!planned.ok) throw new Error(`${planned.error.code}: ${planned.error.message}`);

	const git = createGit({ factoryHome: home, baseEnv: gitEnv });
	const bootstrapSha = options.template
		? ""
		: seedNodeProduct(git, base, { runId, target, home, files: options.files });
	const hostRunner = createHostRunner({
		factoryHome: home,
		baseEnv: gitEnv,
		ids: base.ids,
		now: () => Date.now(),
	});
	const baseRunner = options.template?.runner ?? hostRunner;
	const runner = options.wrapRunner ? options.wrapRunner(baseRunner) : baseRunner;
	const deps: BuildRunDeps = {
		...base,
		provider: provider as ProviderPort,
		factoryFiles,
		templates: createFsTemplateStore({ repoRoot: REPO_ROOT }),
		writer: createFsTargetWriter(),
		git,
		runner,
		...(options.preview ? { preview: options.preview } : {}),
	};
	const taskIds = Object.fromEntries(
		base.storage.taskMeta.listByRun(runId).map((meta) => [meta.key, meta.taskId]),
	);
	return {
		home,
		clock,
		runId,
		target,
		git,
		deps,
		storage: base.storage,
		scripted: inner,
		bootstrapSha,
		taskIds,
		taskOf: (key: string) => {
			const found = base.storage.tasks.get(taskIds[key] ?? "");
			if (!found) throw new Error(`no task ${key}`);
			return found;
		},
		buildOf: (key: string) => base.storage.taskBuilds.get(taskIds[key] ?? ""),
		builderCalls: () => inner.calls.filter((c) => c.role === "builder"),
		roleCalls: (role: string) => inner.calls.filter((c) => c.role === role),
		eventTypes: () => base.storage.events.list(runId, {}).map((e) => e.type),
		events: (type: string) => base.storage.events.list(runId, {}).filter((e) => e.type === type),
	};
};

export type BuildEnv = Awaited<ReturnType<typeof createBuildEnv>>;

export const passReview = (area: ReviewArea, acks: string[] = []): ScriptedResult =>
	good({
		area,
		verdict: "pass",
		findings: [],
		requiresReviewAck: acks.map((path) => ({ path, decision: "ok", note: "reviewed" })),
	});

export const reviewFinding = (over: Record<string, unknown> = {}) => ({
	id: "S1",
	severity: "high",
	confidence: "high",
	title: "Unvalidated input reaches the handler",
	file: "src/add.js",
	lineStart: 1,
	lineEnd: 1,
	evidence: "the value is used without validation",
	impact: "malformed input is accepted",
	recommendation: "validate the input",
	...over,
});

export const findingsReview = (
	area: ReviewArea,
	findings: Record<string, unknown>[],
	acks: { path: string; decision?: string }[] = [],
): ScriptedResult =>
	good({
		area,
		verdict: "findings",
		findings,
		requiresReviewAck: acks.map((ack) => ({ decision: "ok", note: "reviewed", ...ack })),
	});

export const blockedReview = (area: ReviewArea, reason: string): ScriptedResult =>
	good({ area, verdict: "blocked", reason, findings: [], requiresReviewAck: [] });

export const refuterOutcomes = (
	outcomes: { id: string; outcome: "confirmed" | "refuted" | "uncertain" }[],
): ScriptedResult =>
	good({ outcomes: outcomes.map((o) => ({ ...o, evidence: `evidence for ${o.id}` })) });

export const approverSays = (
	recommendation: "accept" | "repair" | "block",
	repairTasks: { findingIds: string[]; instruction: string }[] = [],
): ScriptedResult => good({ recommendation, repairTasks, notes: "" });

export type ChainEnvOptions = Pick<BuildEnvOptions, "tasks" | "builder" | "reviewers" | "spec">;

export const createChainEnv = (options: ChainEnvOptions) => {
	const home = makeTempDir();
	const clock = createFakeClock();
	const inner = createScriptedProvider({
		...planScripts(options.tasks, ["static-landing"], options.spec ?? DEFAULT_SPEC),
		builder: options.builder,
		"reviewer-security": options.reviewers?.security ?? [],
		"reviewer-code": options.reviewers?.code ?? [],
		"reviewer-ux": options.reviewers?.ux ?? [],
		"reviewer-ui": options.reviewers?.ui ?? [],
		"reviewer-legal": options.reviewers?.legal ?? [],
		"review-refuter": options.reviewers?.refuter ?? [],
		approver: options.reviewers?.approver ?? [],
	});
	const provider = hooked(inner, options as BuildEnvOptions);
	const base = openEnv(home, clock, { provider: inner });
	const factoryFiles: FactoryFiles = {
		read: (path) =>
			path === "factory/policies/checks.json"
				? ok({ content: JSON.stringify(NODE_POLICY), sha256: "0".repeat(64) })
				: base.factoryFiles.read(path),
	};
	const target = join(makeTempDir(), "product");
	const prdPath = writePrd(home);
	const git = createGit({ factoryHome: home, baseEnv: gitEnv });
	const runner = createHostRunner({
		factoryHome: home,
		baseEnv: gitEnv,
		ids: base.ids,
		now: () => Date.now(),
	});
	const deps: BuildRunDeps = {
		...base,
		provider: provider as ProviderPort,
		factoryFiles,
		templates: createFsTemplateStore({ repoRoot: REPO_ROOT }),
		writer: createFsTargetWriter(),
		git,
		runner,
	};
	return {
		home,
		clock,
		target,
		prdPath,
		deps,
		start: base,
		git,
		storage: base.storage,
		scripted: inner,
		builderCalls: () => inner.calls.filter((c) => c.role === "builder"),
		prepare: async (runId: string) => {
			const run = base.storage.runs.get(runId);
			const booted = base.storage.events
				.list(runId, {})
				.some((event) => event.type === "product.bootstrapped");
			if (run?.state === "PLANNING" && !booted) {
				seedNodeProduct(git, base, { runId, target, home, files: undefined });
			}
			return ok(deps);
		},
	};
};
