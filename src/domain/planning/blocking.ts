import type { Contradiction, Requirement } from "../../contracts/planning.js";

type Blockable = { key: string; requirementIds: readonly string[]; dependsOn: readonly string[] };

export const blockedTaskReasons = (
	tasks: readonly Blockable[],
	contradictions: readonly Contradiction[],
): Map<string, string> => {
	const reasons = new Map<string, string>();
	for (const task of tasks) {
		const hits = contradictions.filter(
			(c) => c.critical && c.requirementIds.some((id) => task.requirementIds.includes(id)),
		);
		if (hits.length > 0) {
			reasons.set(task.key, `Critical contradiction ${hits.map((c) => c.id).join(", ")}`);
		}
	}
	for (const task of tasks) {
		if (reasons.has(task.key)) continue;
		const blockedDep = task.dependsOn.find((dep) => reasons.has(dep));
		if (blockedDep !== undefined) reasons.set(task.key, `Depends on blocked task ${blockedDep}`);
	}
	return reasons;
};

export const mustRequirementsAllBlocked = (
	requirements: readonly Requirement[],
	tasks: readonly Blockable[],
	blockedKeys: ReadonlySet<string>,
): boolean => {
	const musts = requirements.filter((r) => r.priority === "must");
	if (musts.length === 0) return false;
	return musts.every((r) => {
		const covering = tasks.filter((t) => t.requirementIds.includes(r.id));
		return covering.length > 0 && covering.every((t) => blockedKeys.has(t.key));
	});
};
