import type { Artifact } from "../../contracts/planning.js";
import { isPresetId, PRESETS } from "../../domain/planning/presets.js";
import { sha256Of } from "../../shared/hash.js";
import { fail, ok, type Result } from "../../shared/result.js";
import { contextPackPath, readVerified, recordArtifacts } from "./artifacts.js";
import type { PlanDeps, PlanError } from "./deps.js";
import { parseSpecFile } from "./spec-files.js";

export type ContextItem = {
	kind:
		| "product-summary"
		| "requirement"
		| "assumption"
		| "contradiction"
		| "adr"
		| "preset"
		| "task";
	id: string;
	sourcePath: string;
	sha256: string;
	version: string;
	content: unknown;
};

export type ContextPack = {
	runId: string;
	taskId: string;
	specVersion: number;
	items: ContextItem[];
};

const sizeOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

const overlaps = (a: readonly string[], b: readonly string[]): boolean =>
	a.some((id) => b.includes(id));

const failure = (code: string, message: string): Result<never, PlanError> => fail(code, message);

export const buildContextPack = (
	deps: PlanDeps,
	input: { runId: string; taskId: string },
): Result<{ pack: ContextPack; artifact: Artifact; reused: boolean }, PlanError> => {
	const { storage } = deps;
	const run = storage.runs.get(input.runId);
	if (!run) return failure("run_not_found", `Run ${input.runId} not found`);
	const task = storage.tasks.get(input.taskId);
	const meta = storage.taskMeta.getByTask(input.taskId);
	if (!task || !meta || task.runId !== run.id) {
		return failure("task_not_found", `Task ${input.taskId} is not part of run ${run.id}`);
	}
	const specVersion = storage.specs.latestVersion(run.id);
	const specArtifact =
		specVersion === null ? undefined : storage.artifacts.find(run.id, "spec", "", specVersion);
	if (specVersion === null || !specArtifact)
		return failure("spec_missing", "Run has no specification");
	const specText = readVerified(deps, specArtifact);
	if (!specText.ok) return specText;
	const specFile = parseSpecFile(specText.value);
	if (!specFile) return failure("artifact_corrupted", "Spec artifact is invalid");

	const rows = storage.specs.getSpec(run.id, specVersion);
	const specSource = {
		sourcePath: specArtifact.path,
		sha256: specArtifact.sha256,
		version: `spec-v${specVersion}`,
	};
	const items: ContextItem[] = [
		{
			kind: "product-summary",
			id: "summary",
			...specSource,
			content: {
				requirementCount: rows.requirements.length,
				outOfScope: specFile.spec.outOfScope,
			},
		},
		...rows.requirements
			.filter((r) => meta.requirementIds.includes(r.id))
			.map((r): ContextItem => ({ kind: "requirement", id: r.id, ...specSource, content: r })),
		...rows.assumptions
			.filter((a) => overlaps(a.requirementIds, meta.requirementIds))
			.map((a): ContextItem => ({ kind: "assumption", id: a.id, ...specSource, content: a })),
		...rows.contradictions
			.filter((c) => overlaps(c.requirementIds, meta.requirementIds))
			.map((c): ContextItem => ({ kind: "contradiction", id: c.id, ...specSource, content: c })),
	];
	for (const decision of storage.specs.listDecisions(run.id, 1)) {
		const adr = storage.artifacts.find(run.id, "adr", decision.id, 1);
		if (!adr) return failure("artifact_corrupted", `ADR ${decision.id} has no recorded artifact`);
		items.push({
			kind: "adr",
			id: decision.id,
			sourcePath: adr.path,
			sha256: adr.sha256,
			version: "architecture-v1",
			content: decision,
		});
	}
	for (const presetId of run.presetIds.filter(isPresetId)) {
		const doc = deps.factoryFiles.read(PRESETS[presetId].docPath);
		if (!doc.ok) return failure("factory_file_unreadable", doc.error.message);
		items.push({
			kind: "preset",
			id: presetId,
			sourcePath: PRESETS[presetId].docPath,
			sha256: doc.value.sha256,
			version: `sha256:${doc.value.sha256.slice(0, 12)}`,
			content: doc.value.content,
		});
	}
	const planArtifact = storage.artifacts.find(run.id, "plan", "", 1);
	if (!planArtifact) return failure("artifact_corrupted", "Run has no recorded plan");
	items.push({
		kind: "task",
		id: meta.key,
		sourcePath: planArtifact.path,
		sha256: planArtifact.sha256,
		version: "plan-v1",
		content: {
			taskId: task.id,
			key: meta.key,
			title: task.title,
			acceptance: task.acceptance,
			expectedPaths: meta.expectedPaths,
			risk: meta.risk,
			riskReasons: meta.riskReasons,
			requirementIds: meta.requirementIds,
		},
	});

	const pack: ContextPack = { runId: run.id, taskId: task.id, specVersion, items };
	const content = `${JSON.stringify(pack, null, 2)}\n`;
	const total = Buffer.byteLength(content);
	if (total > deps.settings.contextPackMaxBytes) {
		const sizes = Object.fromEntries(
			items.map((item) => [`${item.kind}:${item.id}`, sizeOf(item)]),
		);
		const biggest = Object.entries(sizes)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5)
			.map(([name, bytes]) => `${name}=${bytes}B`)
			.join(", ");
		return {
			ok: false,
			error: {
				code: "context_pack_too_large",
				message: `Context pack is ${total} bytes, limit ${deps.settings.contextPackMaxBytes}; largest items: ${biggest}`,
				sizes: { total, ...sizes },
			},
		};
	}

	const previous = storage.artifacts.latest(run.id, "context-pack", task.id);
	if (previous && previous.sha256 === sha256Of(content)) {
		return ok({ pack, artifact: previous, reused: true });
	}
	const version = (previous?.version ?? 0) + 1;
	const recorded = recordArtifacts(
		deps,
		run.id,
		[
			{
				kind: "context-pack",
				subject: task.id,
				version,
				path: contextPackPath(task.id, version),
				content,
				producer: "engine",
			},
		],
		() => ok(undefined),
	);
	const artifact = recorded.ok ? recorded.value[0] : undefined;
	return recorded.ok && artifact
		? ok({ pack, artifact, reused: false })
		: (recorded as Result<never, PlanError>);
};
