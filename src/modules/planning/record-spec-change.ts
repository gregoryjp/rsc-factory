import { type SpecOutput, SpecOutputSchema } from "../../contracts/planning.js";
import { validateSpec } from "../../domain/planning/gates.js";
import { renderSpecMarkdown } from "../../domain/planning/render.js";
import { diffRequirements } from "../../domain/planning/spec-diff.js";
import { fail, ok, type Result } from "../../shared/result.js";
import { readVerified, recordArtifacts, specPaths } from "./artifacts.js";
import type { PlanDeps, PlanError } from "./deps.js";
import { parseSpecFile, serializeSpecFile } from "./spec-files.js";

export type SpecChange = {
	fromVersion: number;
	toVersion: number;
	changedRequirementIds: string[];
	impactedTaskIds: string[];
};

export const recordSpecChange = (
	deps: PlanDeps,
	input: { runId: string; spec: SpecOutput },
): Result<SpecChange, PlanError> => {
	const { storage, clock } = deps;
	const run = storage.runs.get(input.runId);
	if (!run) return fail("run_not_found", `Run ${input.runId} not found`);
	const parsed = SpecOutputSchema.safeParse(input.spec);
	if (!parsed.success) return fail("spec_invalid", parsed.error.message);
	const gate = validateSpec(parsed.data, []);
	if (!gate.ok) return { ok: false, error: gate.error };

	const fromVersion = storage.specs.latestVersion(run.id);
	const previous =
		fromVersion === null ? undefined : storage.artifacts.find(run.id, "spec", "", fromVersion);
	if (fromVersion === null || !previous) return fail("spec_missing", "Run has no specification");
	const previousText = readVerified(deps, previous);
	if (!previousText.ok) return previousText;
	const previousFile = parseSpecFile(previousText.value);
	if (!previousFile) return fail("artifact_corrupted", "Spec artifact is invalid");
	if (JSON.stringify(previousFile.spec) === JSON.stringify(parsed.data)) {
		return fail("spec_unchanged", "The new specification is identical to the current one");
	}

	const toVersion = fromVersion + 1;
	const changed = diffRequirements(previousFile.spec.requirements, parsed.data.requirements);
	const impactedTasks = storage.taskMeta
		.listByRun(run.id)
		.filter((meta) => meta.requirementIds.some((id) => changed.includes(id)));
	const change: SpecChange = {
		fromVersion,
		toVersion,
		changedRequirementIds: changed,
		impactedTaskIds: impactedTasks.map((meta) => meta.taskId),
	};
	const recorded = recordArtifacts(
		deps,
		run.id,
		[
			{
				kind: "spec",
				subject: "",
				version: toVersion,
				path: specPaths(toVersion).json,
				producer: "spec-change",
				content: serializeSpecFile({
					specVersion: toVersion,
					inputHash: run.inputHash,
					spec: parsed.data,
				}),
			},
			{
				kind: "spec-md",
				subject: "",
				version: toVersion,
				path: specPaths(toVersion).markdown,
				producer: "engine",
				content: renderSpecMarkdown(toVersion, parsed.data),
			},
		],
		() => {
			storage.specs.insertSpec(run.id, toVersion, parsed.data);
			storage.events.append({
				runId: run.id,
				type: "spec.changed",
				payload: {
					fromVersion,
					toVersion,
					changedRequirementIds: change.changedRequirementIds,
					impactedTaskIds: change.impactedTaskIds,
					impactedTaskKeys: impactedTasks.map((meta) => meta.key),
				},
				now: clock.now(),
			});
			return ok(undefined);
		},
	);
	return recorded.ok ? ok(change) : recorded;
};
