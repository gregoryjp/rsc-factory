import type { DeploymentPort } from "../../src/modules/delivery/ports.js";
import { ok } from "../../src/shared/result.js";

export type FakeDeployment = DeploymentPort & { calls: string[] };

export const createFakeDeployment = (options: { smokeHealthy: boolean }): FakeDeployment => {
	const calls: string[] = [];
	return {
		calls,
		deploy: async (input) => {
			calls.push(`deploy ${input.commit}`);
			return ok({ deploymentId: "dep-1" });
		},
		smoke: async () => {
			calls.push("smoke");
			return ok({
				healthy: options.smokeHealthy,
				detail: options.smokeHealthy ? "GET /health/ready -> 200" : "GET /health/ready -> 503",
			});
		},
		rollback: async () => {
			calls.push("rollback");
			return ok({ detail: "previous artifact redeployed" });
		},
	};
};
