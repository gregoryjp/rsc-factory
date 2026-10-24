import type { Check } from "../../contracts/entities.js";
import { isCheckEvidenceValid, isCheckPassed } from "../../domain/checks/evidence.js";
import type { CheckPolicyEntry } from "../../domain/checks/policy.js";
import { type Failure, fail, ok, type Result } from "../../shared/result.js";
import type { CheckStep } from "./record-check.js";

export const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
export const CHECK_TIMEOUT_MS = 20 * 60 * 1000;

export type PolicyCommand = "test" | "check";

export const stepsFor = (policy: CheckPolicyEntry, command: PolicyCommand): CheckStep[] => [
	...(policy.install.length > 0
		? [{ argv: policy.install, env: {}, timeoutMs: INSTALL_TIMEOUT_MS }]
		: []),
	{ argv: policy[command], env: {}, timeoutMs: CHECK_TIMEOUT_MS },
];

export const completedFinalCheck = (
	checks: readonly Check[],
	expectedSteps: number,
): Check | undefined => (checks.length === expectedSteps ? checks.at(-1) : undefined);

export const assertDoneEvidence = (
	check: Check | undefined,
	input: { head: string; taskId: string | null; argv: readonly string[] },
): Result<Check, Failure<"evidence_invalid">> => {
	if (!check) return fail("evidence_invalid", "The integration check is not recorded");
	if (!isCheckEvidenceValid(check, input.head)) {
		return fail(
			"evidence_invalid",
			`Check ${check.id} ran on ${check.commitSha}, not on integration commit ${input.head}`,
		);
	}
	if (!isCheckPassed(check)) return fail("evidence_invalid", `Check ${check.id} did not pass`);
	if (check.taskId !== input.taskId) {
		return fail("evidence_invalid", `Check ${check.id} belongs to another task`);
	}
	if (check.argv.join("\0") !== input.argv.join("\0")) {
		return fail("evidence_invalid", `Check ${check.id} is not the full check command`);
	}
	return ok(check);
};
