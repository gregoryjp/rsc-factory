import type { AppDeps } from "../deps.js";

export const promoteReadyTasks = ({ storage, clock }: AppDeps, runId: string): string[] =>
	storage.tasks.listPromotable(runId).flatMap((task) => {
		const now = clock.now();
		const moved = storage.tasks.updateState({
			id: task.id,
			expectedVersion: task.version,
			to: "READY",
			now,
		});
		if (!moved.ok) return [];
		storage.events.append({ runId, taskId: task.id, type: "task.ready", now });
		return [task.id];
	});
