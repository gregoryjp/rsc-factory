import { type SeedTaskInput, SeedTaskInputSchema, type Task } from "../../contracts/entities.js";
import { isTerminalRun } from "../../domain/run-machine.js";
import { type Failure, fail, ok, type Result } from "../../shared/result.js";
import type { AppDeps } from "../deps.js";
import type { StorageFailure } from "../storage.js";

export type SeedTasksError =
	| Failure<"run_not_found" | "run_terminal" | "invalid_tasks" | "invalid_dependencies">
	| StorageFailure;

export const seedTasks = (
	{ storage, clock, ids }: AppDeps,
	input: { runId: string; tasks: SeedTaskInput[] },
): Result<Task[], SeedTasksError> => {
	const parsed = SeedTaskInputSchema.array().min(1).safeParse(input.tasks);
	if (!parsed.success) return fail("invalid_tasks", parsed.error.message);

	return storage.transaction<Task[], SeedTasksError>(() => {
		const run = storage.runs.get(input.runId);
		if (!run) return fail("run_not_found", `Run ${input.runId} not found`);
		if (isTerminalRun(run.state)) return fail("run_terminal", `Run ${run.id} is ${run.state}`);

		const idByKey = new Map<string, string>();
		for (const task of parsed.data) {
			if (idByKey.has(task.key)) return fail("invalid_tasks", `Duplicate task key ${task.key}`);
			if (new Set(task.dependsOn).size !== task.dependsOn.length) {
				return fail("invalid_dependencies", `Task ${task.key} lists a dependency more than once`);
			}
			for (const dep of task.dependsOn) {
				if (!idByKey.has(dep)) {
					return fail(
						"invalid_dependencies",
						`Task ${task.key} depends on ${dep}, which is not declared before it`,
					);
				}
			}
			idByKey.set(task.key, ids("task"));
		}

		const now = clock.now();
		const rows = parsed.data.map((task) => ({
			id: idByKey.get(task.key) ?? "",
			runId: run.id,
			title: task.title,
			acceptance: task.acceptance,
			state: task.dependsOn.length === 0 ? ("READY" as const) : ("PENDING" as const),
			dependsOn: task.dependsOn.map((dep) => idByKey.get(dep) ?? ""),
			now,
		}));
		storage.tasks.insertMany(rows);
		for (const row of rows) {
			storage.events.append({
				runId: run.id,
				taskId: row.id,
				type: "task.seeded",
				payload: { title: row.title, state: row.state },
				now,
			});
		}
		return ok(rows.flatMap((row) => storage.tasks.get(row.id) ?? []));
	});
};
