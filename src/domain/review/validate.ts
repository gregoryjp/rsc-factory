import type {
	ApproverOutput,
	Finding,
	RefuterOutput,
	ReviewArea,
	ReviewerOutput,
} from "../../contracts/review.js";
import { err, ok, type Result } from "../../shared/result.js";
import type { GateFailure } from "../planning/gates.js";
import { isSevere } from "./types.js";

const gateFailure = (errors: string[]): Result<never, GateFailure> =>
	err({ code: "gate_failed", message: errors.join("; "), errors });

const blank = (value: string | undefined): boolean => value === undefined || value.trim() === "";

const duplicates = (values: readonly string[]): string[] => [
	...new Set(values.filter((value, index) => values.indexOf(value) !== index)),
];

const findingErrors = (finding: Finding): string[] => [
	...(isSevere(finding.severity) && blank(finding.file)
		? [`Finding ${finding.id} is ${finding.severity} but names no file`]
		: []),
	...(blank(finding.evidence) ? [`Finding ${finding.id} has blank evidence`] : []),
	...(finding.lineEnd !== undefined && finding.lineStart === undefined
		? [`Finding ${finding.id} has lineEnd without lineStart`]
		: []),
	...(finding.lineEnd !== undefined &&
	finding.lineStart !== undefined &&
	finding.lineEnd < finding.lineStart
		? [`Finding ${finding.id} ends before it starts`]
		: []),
];

const verdictErrors = (output: ReviewerOutput): string[] => {
	const reasonNeeded = output.verdict === "blocked" || output.verdict === "not_applicable";
	return [
		...(output.verdict === "pass" && output.findings.length > 0
			? ["A pass verdict cannot carry findings"]
			: []),
		...(output.verdict === "findings" && output.findings.length === 0
			? ["A findings verdict needs at least one finding"]
			: []),
		...(reasonNeeded && blank(output.reason) ? [`A ${output.verdict} verdict needs a reason`] : []),
		...(reasonNeeded && output.findings.length > 0
			? [`A ${output.verdict} verdict cannot carry findings`]
			: []),
	];
};

const ackErrors = (output: ReviewerOutput, paths: readonly string[]): string[] => {
	if (paths.length === 0 || output.verdict === "blocked") return [];
	const acked = new Map(output.requiresReviewAck.map((ack) => [ack.path, ack]));
	return paths.flatMap((path) => {
		const ack = acked.get(path);
		if (!ack) return [`Missing requiresReviewAck for ${path}`];
		const raised = output.findings.some((finding) => finding.file === path);
		return ack.decision === "finding" && !raised
			? [`Ack for ${path} says finding but no finding references that file`]
			: [];
	});
};

export const validateReviewerOutput = (
	output: ReviewerOutput,
	input: { area: ReviewArea; requiresReviewPaths: readonly string[] },
): Result<ReviewerOutput, GateFailure> => {
	const errors = [
		...(output.area === input.area
			? []
			: [`Output area ${output.area} does not match reviewer area ${input.area}`]),
		...verdictErrors(output),
		...duplicates(output.findings.map((finding) => finding.id)).map(
			(id) => `Duplicate finding id ${id}`,
		),
		...output.findings.flatMap(findingErrors),
		...ackErrors(output, input.requiresReviewPaths),
	];
	return errors.length === 0 ? ok(output) : gateFailure(errors);
};

export const validateRefuterOutput = (
	output: RefuterOutput,
	sentIds: readonly string[],
): Result<RefuterOutput, GateFailure> => {
	const returned = output.outcomes.map((outcome) => outcome.id);
	const errors = [
		...sentIds.filter((id) => !returned.includes(id)).map((id) => `No outcome for finding ${id}`),
		...returned
			.filter((id) => !sentIds.includes(id))
			.map((id) => `Outcome for unknown finding ${id}`),
		...duplicates(returned).map((id) => `Duplicate outcome for ${id}`),
	];
	return errors.length === 0 ? ok(output) : gateFailure(errors);
};

export const validateApproverOutput = (
	output: ApproverOutput,
	knownIds: readonly string[],
): Result<ApproverOutput, GateFailure> => {
	const errors = output.repairTasks.flatMap((task) =>
		task.findingIds
			.filter((id) => !knownIds.includes(id))
			.map((id) => `Repair task names unknown finding ${id}`),
	);
	return errors.length === 0 ? ok(output) : gateFailure(errors);
};
