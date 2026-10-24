import type { ReleasePlan } from "../../domain/release/plan.js";
import type { Failure, Result } from "../../shared/result.js";

export type DeploymentFailure = Failure<string>;

export type DeploymentPort = {
	deploy: (input: {
		runId: string;
		commit: string;
		plan: ReleasePlan;
	}) => Promise<Result<{ deploymentId: string }, DeploymentFailure>>;
	smoke: (input: {
		runId: string;
		deploymentId: string;
		plan: ReleasePlan;
	}) => Promise<Result<{ healthy: boolean; detail: string }, DeploymentFailure>>;
	rollback: (input: {
		runId: string;
		deploymentId: string;
		plan: ReleasePlan;
	}) => Promise<Result<{ detail: string }, DeploymentFailure>>;
};
