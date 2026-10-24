import type { RunnerPreference } from "../../config/env.js";
import type { CommandRunner } from "../../modules/doctor/run-doctor.js";
import type { CheckRunnerPort, RunnerError } from "../../modules/execution/ports.js";
import { fail, ok, type Result } from "../../shared/result.js";

export type RunnerSelection = { runner: CheckRunnerPort; warning: string | null };

const PROBE_TIMEOUT_MS = 10_000;
const HOST_WARNING = "host runner: generated code runs on this machine without isolation";

export const containerUserFor = (
	dockerOperatingSystem: string,
	host: { uid: number; gid: number },
): { uid: number; gid: number } =>
	/docker desktop|name=rootless|name=userns/i.test(dockerOperatingSystem)
		? { uid: 0, gid: 0 }
		: host;

export const selectRunner = async (input: {
	preference: RunnerPreference;
	exec: CommandRunner;
	makeDocker: (dockerOperatingSystem: string) => CheckRunnerPort;
	makeHost: () => CheckRunnerPort;
}): Promise<Result<RunnerSelection, RunnerError>> => {
	if (input.preference === "host") {
		return ok({ runner: input.makeHost(), warning: HOST_WARNING });
	}
	const probe = await input.exec(
		"docker",
		["info", "--format", "{{.OperatingSystem}}|{{json .SecurityOptions}}"],
		PROBE_TIMEOUT_MS,
	);
	if (probe.ok) return ok({ runner: input.makeDocker(probe.value.stdout.trim()), warning: null });
	if (input.preference === "docker") {
		return fail(
			"runner_unavailable",
			`FACTORY_RUNNER=docker but \`docker info\` failed: ${probe.error.message}`,
		);
	}
	return ok({ runner: input.makeHost(), warning: `docker is unavailable; ${HOST_WARNING}` });
};
