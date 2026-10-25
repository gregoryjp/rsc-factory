import { z } from "zod";

const NonEmpty = z.string().min(1);

export const ReqIdSchema = z.string().regex(/^REQ-\d{3,}$/);
export const AssumptionIdSchema = z.string().regex(/^ASM-\d{3}$/);
export const ContradictionIdSchema = z.string().regex(/^CON-\d{3}$/);
export const DecisionIdSchema = z.string().regex(/^ADR-\d{3}$/);

export const PrioritySchema = z.enum(["must", "next"]);
export type Priority = z.infer<typeof PrioritySchema>;

export const RiskSchema = z.enum(["low", "medium", "high"]);
export type Risk = z.infer<typeof RiskSchema>;

export const RequirementSchema = z.strictObject({
	id: ReqIdSchema,
	text: NonEmpty,
	acceptance: z.array(NonEmpty).min(1),
	priority: PrioritySchema,
	sourceRef: NonEmpty,
});
export type Requirement = z.infer<typeof RequirementSchema>;

export const AssumptionSchema = z.strictObject({
	id: AssumptionIdSchema,
	statement: NonEmpty,
	reason: NonEmpty,
	impact: NonEmpty,
	reversible: z.boolean(),
	requirementIds: z.array(ReqIdSchema),
});
export type Assumption = z.infer<typeof AssumptionSchema>;

export const ContradictionSchema = z.strictObject({
	id: ContradictionIdSchema,
	requirementIds: z.array(ReqIdSchema).min(1),
	description: NonEmpty,
	critical: z.boolean(),
});
export type Contradiction = z.infer<typeof ContradictionSchema>;

export const SpecOutputSchema = z.strictObject({
	requirements: z.array(RequirementSchema).min(1),
	assumptions: z.array(AssumptionSchema),
	contradictions: z.array(ContradictionSchema),
	outOfScope: z.array(z.string()),
	openQuestions: z.array(z.string()),
});
export type SpecOutput = z.infer<typeof SpecOutputSchema>;

export const DecisionSchema = z.strictObject({
	id: DecisionIdSchema,
	title: NonEmpty,
	context: NonEmpty,
	decision: NonEmpty,
	alternatives: z.array(NonEmpty),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const ArchitectOutputSchema = z.strictObject({
	presetIds: z.array(NonEmpty).min(1),
	rationale: NonEmpty,
	omitted: z.array(z.string()),
	decisions: z.array(DecisionSchema),
});
export type ArchitectOutput = z.infer<typeof ArchitectOutputSchema>;

export const PlannedTaskSchema = z.strictObject({
	key: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
	title: NonEmpty,
	requirementIds: z.array(ReqIdSchema).min(1),
	dependsOn: z.array(NonEmpty),
	acceptance: z.array(NonEmpty).min(1),
	risk: RiskSchema,
	expectedPaths: z.array(NonEmpty),
});
export type PlannedTask = z.infer<typeof PlannedTaskSchema>;

export const PlannerOutputSchema = z.strictObject({
	tasks: z.array(PlannedTaskSchema).min(1),
});
export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

export const RoleSchema = z.enum([
	"spec-writer",
	"architect",
	"planner",
	"builder",
	"reviewer-security",
	"reviewer-code",
	"reviewer-ux",
	"reviewer-ui",
	"reviewer-legal",
	"review-refuter",
	"approver",
]);
export type Role = z.infer<typeof RoleSchema>;

export const ProviderNameSchema = z.enum(["claude", "codex"]);
export type ProviderName = z.infer<typeof ProviderNameSchema>;

export const EffortSchema = z.enum(["low", "medium", "high", "xhigh"]);
export type Effort = z.infer<typeof EffortSchema>;

const effortOnlyForCodex = (value: { provider: string; effort?: string | undefined }): boolean =>
	value.effort === undefined || value.provider === "codex";

const EFFORT_ISSUE = {
	message: "effort is only supported for the codex provider",
	path: ["effort"],
};

export const FallbackConfigSchema = z
	.strictObject({
		provider: ProviderNameSchema,
		model: NonEmpty,
		effort: EffortSchema.optional(),
	})
	.refine(effortOnlyForCodex, EFFORT_ISSUE);
export type FallbackConfig = z.infer<typeof FallbackConfigSchema>;

export const RoleConfigSchema = z
	.strictObject({
		provider: ProviderNameSchema,
		model: NonEmpty,
		effort: EffortSchema.optional(),
		fallback: FallbackConfigSchema.optional(),
	})
	.refine(effortOnlyForCodex, EFFORT_ISSUE)
	.refine((value) => value.fallback === undefined || value.fallback.provider !== value.provider, {
		message: "the fallback provider must differ from the primary provider",
		path: ["fallback", "provider"],
	});
export type RoleConfig = z.infer<typeof RoleConfigSchema>;

export const RolesConfigSchema = z.strictObject({
	"spec-writer": RoleConfigSchema,
	architect: RoleConfigSchema,
	planner: RoleConfigSchema,
	builder: RoleConfigSchema,
	"reviewer-security": RoleConfigSchema,
	"reviewer-code": RoleConfigSchema,
	"reviewer-ux": RoleConfigSchema,
	"reviewer-ui": RoleConfigSchema,
	"reviewer-legal": RoleConfigSchema,
	"review-refuter": RoleConfigSchema,
	approver: RoleConfigSchema,
});
export type RolesConfig = z.infer<typeof RolesConfigSchema>;

export const ArtifactKindSchema = z.enum([
	"ingest",
	"spec",
	"spec-md",
	"architecture",
	"adr",
	"plan",
	"context-pack",
	"bootstrap",
	"bootstrap-staged",
	"review",
	"blocked-diff",
	"audit-baseline",
	"sast-baseline",
	"report",
	"release-plan",
]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export type Artifact = {
	id: string;
	runId: string;
	kind: ArtifactKind;
	subject: string;
	version: number;
	path: string;
	sha256: string;
	producer: string;
	createdAt: number;
};

export const PlanArtifactSchema = z.strictObject({
	planVersion: z.number().int().positive(),
	specVersion: z.number().int().positive(),
	tasks: z
		.array(
			PlannedTaskSchema.extend({
				modelRisk: RiskSchema,
				riskReasons: z.array(z.string()),
			}),
		)
		.min(1),
});
export type PlanArtifact = z.infer<typeof PlanArtifactSchema>;

export const TargetKindSchema = z.enum(["new", "empty", "git_repo"]);
export type TargetKind = z.infer<typeof TargetKindSchema>;
