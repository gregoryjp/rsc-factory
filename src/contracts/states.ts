import { z } from "zod";

export const RunStateSchema = z.enum([
	"CREATED",
	"INGESTING",
	"SPECIFYING",
	"PLANNING",
	"BUILDING",
	"VERIFYING",
	"REVIEWING",
	"REPAIRING",
	"INTEGRATING",
	"READY_FOR_RELEASE",
	"RELEASING",
	"SUCCEEDED",
	"BLOCKED",
	"FAILED",
	"CANCELED",
]);
export type RunState = z.infer<typeof RunStateSchema>;

export const TaskStateSchema = z.enum([
	"PENDING",
	"READY",
	"LEASED",
	"RUNNING",
	"VERIFYING",
	"REVIEWING",
	"REPAIRING",
	"DONE",
	"BLOCKED",
	"FAILED",
	"CANCELED",
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const DeliveryTargetSchema = z.enum(["local", "production"]);
export type DeliveryTarget = z.infer<typeof DeliveryTargetSchema>;

export const AttemptOutcomeSchema = z.enum([
	"running",
	"completed",
	"failed",
	"interrupted",
	"released",
]);
export type AttemptOutcome = z.infer<typeof AttemptOutcomeSchema>;
