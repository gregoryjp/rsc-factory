import { basename, resolve } from "node:path";
import type { Run } from "../../contracts/entities.js";
import type { DeliveryTarget } from "../../contracts/states.js";
import { type Failure, fail, ok, type Result } from "../../shared/result.js";
import type { AppDeps } from "../deps.js";
import type { StorageFailure } from "../storage.js";
import type { PrdCopyError, PrdFiles, PrdReadError, TargetError, TargetFiles } from "./ports.js";

export type StartRunInput = {
	prdPath: string;
	projectName: string | undefined;
	cwd: string;
	forceNew: boolean;
	deliveryTarget: DeliveryTarget | null;
	targetPath?: string;
	budgetUsd?: number;
};

export type StartRunError =
	| PrdReadError
	| PrdCopyError
	| TargetError
	| Failure<"invalid_project" | "delivery_mismatch" | "target_mismatch">
	| StorageFailure;

const POLICY_VERSION = "0";

export const startRun = (
	deps: AppDeps & { prdFiles: PrdFiles; targets: TargetFiles },
	input: StartRunInput,
): Result<{ run: Run; reused: boolean }, StartRunError> => {
	const { storage, clock, ids, prdFiles } = deps;
	const prd = prdFiles.read(input.prdPath);
	if (!prd.ok) return prd;

	const target =
		input.targetPath === undefined ? undefined : deps.targets.resolve(input.targetPath);
	if (target && !target.ok) return target;

	const projectName = (input.projectName ?? basename(resolve(input.cwd))).trim();
	if (projectName.length === 0) return fail("invalid_project", "Project name is empty");

	return storage.transaction<{ run: Run; reused: boolean }, StartRunError>(() => {
		const now = clock.now();
		const existingProject = storage.projects.findByName(projectName);
		const project = existingProject ?? {
			id: ids("prj"),
			name: projectName,
			authorizedPath: resolve(input.cwd),
			preset: null,
			policyVersion: POLICY_VERSION,
			createdAt: now,
		};
		if (!existingProject) storage.projects.insert(project);

		if (!input.forceNew) {
			const active = storage.runs.findActiveByInput(project.id, prd.value.hash);
			if (active) {
				if (input.deliveryTarget !== null && active.deliveryTarget !== input.deliveryTarget) {
					return fail(
						"delivery_mismatch",
						`Run ${active.id} already exists for this PRD with delivery ${active.deliveryTarget ?? "undeclared"}; use --new to create a run with ${input.deliveryTarget}`,
					);
				}
				if (target && active.targetPath !== target.value.path) {
					return fail(
						"target_mismatch",
						`Run ${active.id} already exists for this PRD with target ${active.targetPath ?? "none"}; use --new to create a run for ${target.value.path}`,
					);
				}
				return ok({ run: active, reused: true });
			}
		}

		const runId = ids("run");
		const copy = deps.prdFiles.persistCopy(runId, prd.value.content);
		if (!copy.ok) return copy;

		const run: Run = {
			id: runId,
			projectId: project.id,
			inputHash: prd.value.hash,
			inputPath: copy.value,
			state: "CREATED",
			deliveryTarget: input.deliveryTarget,
			costLimitUsd: null,
			targetPath: target?.value.path ?? null,
			targetKind: target?.value.kind ?? null,
			presetIds: [],
			providerMode: null,
			version: 1,
			createdAt: now,
			updatedAt: now,
		};
		storage.runs.insert(run);
		if (input.budgetUsd !== undefined) storage.budgets.setLimit(runId, input.budgetUsd);
		storage.events.append({
			runId,
			type: "run.created",
			payload: {
				projectId: project.id,
				inputHash: run.inputHash,
				forced: input.forceNew,
				budgetUsd: input.budgetUsd ?? null,
				targetPath: run.targetPath,
				targetKind: run.targetKind,
			},
			now,
		});
		return ok({ run, reused: false });
	});
};
