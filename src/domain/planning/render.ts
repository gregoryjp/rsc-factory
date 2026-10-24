import type { Decision, SpecOutput } from "../../contracts/planning.js";

const bullets = (items: readonly string[]): string[] =>
	items.length === 0 ? ["- none"] : items.map((item) => `- ${item}`);

export const renderSpecMarkdown = (version: number, spec: SpecOutput): string =>
	[
		`# Specification v${version}`,
		"",
		"## Requirements",
		...spec.requirements.flatMap((r) => [
			"",
			`### ${r.id} (${r.priority})`,
			"",
			r.text,
			"",
			`Source: ${r.sourceRef}`,
			"",
			"Acceptance:",
			...bullets(r.acceptance),
		]),
		"",
		"## Assumptions",
		...spec.assumptions.flatMap((a) => [
			"",
			`### ${a.id}`,
			"",
			a.statement,
			"",
			`- Reason: ${a.reason}`,
			`- Impact: ${a.impact}`,
			`- Reversible: ${a.reversible ? "yes" : "no"}`,
			`- Requirements: ${a.requirementIds.join(", ") || "none"}`,
		]),
		"",
		"## Contradictions",
		...spec.contradictions.flatMap((c) => [
			"",
			`### ${c.id} (${c.critical ? "critical" : "non-critical"})`,
			"",
			c.description,
			"",
			`- Requirements: ${c.requirementIds.join(", ")}`,
		]),
		"",
		"## Out of scope",
		"",
		...bullets(spec.outOfScope),
		"",
		"## Open questions",
		"",
		...bullets(spec.openQuestions),
		"",
	].join("\n");

export const renderDecisionMarkdown = (decision: Decision): string =>
	[
		`# ${decision.id}: ${decision.title}`,
		"",
		"## Context",
		"",
		decision.context,
		"",
		"## Decision",
		"",
		decision.decision,
		"",
		"## Alternatives",
		"",
		...bullets(decision.alternatives),
		"",
	].join("\n");
