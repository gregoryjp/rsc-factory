import {
	type CheckPolicyEntry,
	lookupCheckPolicy,
	parseCheckPolicy,
} from "../../domain/checks/policy.js";
import { type Failure, fail, type Result } from "../../shared/result.js";
import type { FactoryFiles } from "../planning/ports.js";
import type { Storage } from "../storage.js";

export const CHECK_POLICY_PATH = "factory/policies/checks.json";

export const loadCheckPolicy = (
	deps: { storage: Storage; factoryFiles: FactoryFiles },
	runId: string,
): Result<CheckPolicyEntry & { templateId: string }, Failure<string>> => {
	const bootstrapped = deps.storage.events
		.list(runId, {})
		.filter((event) => event.type === "product.bootstrapped")
		.at(-1);
	const templateId = bootstrapped?.payload.templateId;
	if (typeof templateId !== "string") {
		return fail("bootstrap_missing", `Run ${runId} has no bootstrapped product`);
	}
	const file = deps.factoryFiles.read(CHECK_POLICY_PATH);
	if (!file.ok) return file;
	const policy = parseCheckPolicy(file.value.content);
	if (!policy.ok) return policy;
	const entry = lookupCheckPolicy(policy.value, templateId);
	if (!entry.ok) return entry;
	return { ok: true, value: { ...entry.value, templateId } };
};
