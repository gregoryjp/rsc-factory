import type { Requirement } from "../../contracts/planning.js";

export const diffRequirements = (
	before: readonly Requirement[],
	after: readonly Requirement[],
): string[] => {
	const beforeById = new Map(before.map((r) => [r.id, JSON.stringify(r)]));
	const afterById = new Map(after.map((r) => [r.id, JSON.stringify(r)]));
	const ids = new Set([...beforeById.keys(), ...afterById.keys()]);
	return [...ids].filter((id) => beforeById.get(id) !== afterById.get(id)).sort();
};
