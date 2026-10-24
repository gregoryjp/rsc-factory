import type {
	ArchitectOutput,
	PlannedTask,
	PlannerOutput,
	SpecOutput,
} from "../../contracts/planning.js";
import { err, type Failure, ok, type Result } from "../../shared/result.js";
import { isSafeExpectedPath } from "./paths.js";
import { isPresetId, PRESETS } from "./presets.js";

export type GateFailure = Failure<"gate_failed"> & { errors: string[] };

const gateFailure = (errors: string[]): Result<never, GateFailure> =>
	err({ code: "gate_failed", message: errors.join("; "), errors });

const duplicates = (values: readonly string[]): string[] => [
	...new Set(values.filter((value, index) => values.indexOf(value) !== index)),
];

const blank = (value: string): boolean => value.trim().length === 0;

export const validateSpec = (
	spec: SpecOutput,
	declaredIds: readonly string[],
): Result<SpecOutput, GateFailure> => {
	const errors: string[] = [];
	const ids = spec.requirements.map((r) => r.id);
	for (const id of duplicates(ids)) errors.push(`Duplicate requirement id ${id}`);
	for (const id of duplicates(spec.assumptions.map((a) => a.id))) {
		errors.push(`Duplicate assumption id ${id}`);
	}
	for (const id of duplicates(spec.contradictions.map((c) => c.id))) {
		errors.push(`Duplicate contradiction id ${id}`);
	}
	if (declaredIds.length > 0) {
		const invented = ids.filter((id) => !declaredIds.includes(id));
		const missing = declaredIds.filter((id) => !ids.includes(id));
		if (invented.length > 0) {
			errors.push(`Requirement ids not declared in the PRD: ${[...new Set(invented)].join(", ")}`);
		}
		if (missing.length > 0) {
			errors.push(`Requirement ids declared in the PRD but missing: ${missing.join(", ")}`);
		}
	}
	for (const r of spec.requirements) {
		if (blank(r.text) || r.acceptance.some(blank)) {
			errors.push(`Requirement ${r.id} has blank text or acceptance`);
		}
	}
	const known = new Set(ids);
	for (const a of spec.assumptions) {
		for (const id of a.requirementIds.filter((x) => !known.has(x))) {
			errors.push(`Assumption ${a.id} references unknown requirement ${id}`);
		}
	}
	for (const c of spec.contradictions) {
		for (const id of c.requirementIds.filter((x) => !known.has(x))) {
			errors.push(`Contradiction ${c.id} references unknown requirement ${id}`);
		}
	}
	return errors.length === 0 ? ok(spec) : gateFailure(errors);
};

export const validateArchitecture = (
	architecture: ArchitectOutput,
): Result<ArchitectOutput, GateFailure> => {
	const errors: string[] = [];
	for (const id of duplicates(architecture.presetIds)) errors.push(`Duplicate preset ${id}`);
	for (const id of architecture.presetIds.filter((x) => !isPresetId(x))) {
		errors.push(`Unknown preset ${id}`);
	}
	for (const id of architecture.presetIds.filter(isPresetId)) {
		for (const other of PRESETS[id].conflictsWith) {
			if (architecture.presetIds.includes(other) && id < other) {
				errors.push(`Presets ${id} and ${other} cannot be combined`);
			}
		}
	}
	for (const id of duplicates(architecture.decisions.map((d) => d.id))) {
		errors.push(`Duplicate decision id ${id}`);
	}
	return errors.length === 0 ? ok(architecture) : gateFailure(errors);
};

type Ordering = { ordered: PlannedTask[] } | { cycle: string[] };

const topologicalOrder = (tasks: readonly PlannedTask[]): Ordering => {
	const remaining = new Map(tasks.map((t) => [t.key, new Set(t.dependsOn)]));
	const ordered: PlannedTask[] = [];
	while (remaining.size > 0) {
		const ready = tasks.filter((t) => remaining.get(t.key)?.size === 0 && remaining.has(t.key));
		const next = ready[0];
		if (next === undefined) return { cycle: [...remaining.keys()] };
		ordered.push(next);
		remaining.delete(next.key);
		for (const deps of remaining.values()) deps.delete(next.key);
	}
	return { ordered };
};

export const validatePlan = (
	plan: PlannerOutput,
	spec: SpecOutput,
): Result<PlannedTask[], GateFailure> => {
	const errors: string[] = [];
	const keys = plan.tasks.map((t) => t.key);
	for (const key of duplicates(keys)) errors.push(`Duplicate task key ${key}`);
	const knownReqs = new Set(spec.requirements.map((r) => r.id));
	for (const t of plan.tasks) {
		if (t.acceptance.some(blank)) errors.push(`Task ${t.key} has blank acceptance`);
		if (blank(t.title)) errors.push(`Task ${t.key} has a blank title`);
		for (const path of t.expectedPaths.filter((p) => !isSafeExpectedPath(p))) {
			errors.push(`Task ${t.key} has unsafe expected path "${path}"`);
		}
		for (const id of t.requirementIds.filter((x) => !knownReqs.has(x))) {
			errors.push(`Task ${t.key} references unknown requirement ${id}`);
		}
		for (const dep of duplicates(t.dependsOn)) {
			errors.push(`Task ${t.key} lists dependency ${dep} more than once`);
		}
		for (const dep of t.dependsOn) {
			if (dep === t.key) errors.push(`Task ${t.key} depends on itself`);
			else if (!keys.includes(dep)) errors.push(`Task ${t.key} depends on unknown task ${dep}`);
		}
	}
	const covered = new Set(plan.tasks.flatMap((t) => t.requirementIds));
	for (const r of spec.requirements) {
		if (r.priority === "must" && !covered.has(r.id)) {
			errors.push(`Must requirement ${r.id} is not covered by any task`);
		}
	}
	if (errors.length > 0) return gateFailure(errors);
	const ordering = topologicalOrder(plan.tasks);
	return "cycle" in ordering
		? gateFailure([`Dependency cycle among tasks: ${ordering.cycle.join(", ")}`])
		: ok(ordering.ordered);
};
