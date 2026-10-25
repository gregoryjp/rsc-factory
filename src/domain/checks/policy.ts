import { z } from "zod";
import { type Failure, fail, ok, type Result } from "../../shared/result.js";

const Argv = z.array(z.string().min(1)).min(1);

const RelativePath = z
	.string()
	.min(1)
	.regex(/^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._/-]+$/);

export const PreviewPolicySchema = z.strictObject({
	install: Argv,
	build: Argv.optional(),
	staticDir: RelativePath,
	routesFile: RelativePath.optional(),
	authFile: RelativePath.optional(),
	api: z
		.strictObject({
			build: Argv.optional(),
			migrate: Argv.optional(),
			seed: Argv.optional(),
			start: Argv,
			port: z.number().int().min(1024).max(65535),
			healthPath: z.string().regex(/^\/[A-Za-z0-9._~/-]*$/),
		})
		.optional(),
});
export type PreviewPolicy = z.infer<typeof PreviewPolicySchema>;

export const CheckPolicyEntrySchema = z.strictObject({
	install: z.array(z.string().min(1)),
	test: Argv,
	check: Argv,
	audit: Argv.optional(),
	preview: PreviewPolicySchema.optional(),
});
export type CheckPolicyEntry = z.infer<typeof CheckPolicyEntrySchema>;

const CheckPolicySchema = z.record(z.string(), CheckPolicyEntrySchema);
export type CheckPolicy = z.infer<typeof CheckPolicySchema>;

export type CheckPolicyError = Failure<"check_policy_invalid" | "check_policy_missing">;

export const parseCheckPolicy = (text: string): Result<CheckPolicy, CheckPolicyError> => {
	try {
		const parsed = CheckPolicySchema.safeParse(JSON.parse(text));
		return parsed.success
			? ok(parsed.data)
			: fail("check_policy_invalid", parsed.error.message.slice(0, 300));
	} catch {
		return fail("check_policy_invalid", "Check policy is not valid JSON");
	}
};

export const lookupCheckPolicy = (
	policy: CheckPolicy,
	templateId: string,
): Result<CheckPolicyEntry, CheckPolicyError> => {
	const entry = Object.hasOwn(policy, templateId) ? policy[templateId] : undefined;
	return entry === undefined
		? fail("check_policy_missing", `No check policy for template ${templateId}`)
		: ok(entry);
};
