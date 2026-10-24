import { z } from "zod";
import { TargetKindSchema } from "./planning.js";
import { DeliveryTargetSchema, RunStateSchema, TaskStateSchema } from "./states.js";

export const ProjectSchema = z.object({
	id: z.string(),
	name: z.string().min(1),
	authorizedPath: z.string(),
	preset: z.string().nullable(),
	policyVersion: z.string(),
	createdAt: z.number().int(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const RunSchema = z.object({
	id: z.string(),
	projectId: z.string(),
	inputHash: z.string().length(64),
	inputPath: z.string(),
	state: RunStateSchema,
	deliveryTarget: DeliveryTargetSchema.nullable(),
	costLimitUsd: z.number().nonnegative().nullable(),
	targetPath: z.string().nullable(),
	targetKind: TargetKindSchema.nullable(),
	presetIds: z.array(z.string()),
	providerMode: z.enum(["real", "fake"]).nullable(),
	version: z.number().int().positive(),
	createdAt: z.number().int(),
	updatedAt: z.number().int(),
});
export type Run = z.infer<typeof RunSchema>;

export const TaskSchema = z.object({
	id: z.string(),
	runId: z.string(),
	title: z.string().min(1),
	acceptance: z.string().min(1),
	state: TaskStateSchema,
	attempt: z.number().int().nonnegative(),
	version: z.number().int().positive(),
	dependsOn: z.array(z.string()),
	leaseOwner: z.string().nullable(),
	leaseExpiresAt: z.number().int().nullable(),
	heartbeatAt: z.number().int().nullable(),
	baseCommit: z.string().nullable(),
	createdAt: z.number().int(),
	updatedAt: z.number().int(),
});
export type Task = z.infer<typeof TaskSchema>;

export const SeedTaskInputSchema = z.object({
	key: z.string().min(1),
	title: z.string().min(1),
	acceptance: z.string().min(1),
	dependsOn: z.array(z.string()).default([]),
});
export type SeedTaskInput = z.input<typeof SeedTaskInputSchema>;

export const CheckSchema = z.object({
	id: z.string(),
	runId: z.string(),
	taskId: z.string().nullable(),
	argv: z.array(z.string()),
	cwd: z.string(),
	exitCode: z.number().int(),
	durationMs: z.number().int().nonnegative(),
	commitSha: z.string(),
	logPath: z.string(),
	logSha256: z.string().length(64),
	isolated: z.boolean(),
	createdAt: z.number().int(),
});
export type Check = z.infer<typeof CheckSchema>;
