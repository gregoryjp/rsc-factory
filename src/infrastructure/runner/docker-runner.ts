import { randomBytes } from "node:crypto";
import { isValidRunId } from "../../domain/ids/run-id.js";
import type { CheckRunnerPort, RunnerError } from "../../modules/execution/ports.js";
import { fail, ok, type Result } from "../../shared/result.js";
import type { IdGenerator } from "../ids.js";
import {
	buildCheckArgv,
	buildKillArgv,
	buildListArgv,
	buildNetworkCreateArgv,
	buildPostgresArgv,
	buildReadyArgv,
	buildRemoveArgv,
	checkContainerName,
	type DockerObjectKind,
	isValidDbIdent,
} from "./docker-argv.js";
import { createDockerExec, type DockerCall } from "./docker-cli.js";
import { checkLogPath, validateRunCheckInput } from "./host-runner.js";
import { runLogged } from "./run-logged.js";

const DB_USER = "factory";
const DB_PORT = 5432;
const READY_POLL_MS = 500;
const RESERVED_ENV = new Set(["TEST_DATABASE_URL", "DATABASE_URL", "NODE_ENV"]);

export type DockerRunnerConfig = {
	factoryHome: string;
	dockerBin: string;
	baseEnv: Readonly<Record<string, string>>;
	nodeImage: string;
	postgresImage: string;
	user: { uid: number; gid: number };
	homeDir: string;
	slug: string;
	ids: IdGenerator;
	now: () => number;
	readyTimeoutMs: number;
};

type Services = { databaseUrl: string };

export const createDockerRunner = (config: DockerRunnerConfig): CheckRunnerPort => {
	const dbName = `${config.slug}_test`;
	const services = new Map<string, Promise<Result<Services, RunnerError>>>();

	const exec = createDockerExec({ dockerBin: config.dockerBin, baseEnv: config.baseEnv });
	const docker = (
		args: readonly string[],
		extraEnv: Readonly<Record<string, string>> = {},
	): Promise<Result<DockerCall, RunnerError>> => exec(args, { env: extraEnv });

	const dockerOk = async (
		args: readonly string[],
		extraEnv: Readonly<Record<string, string>> = {},
	): Promise<Result<string, RunnerError>> => {
		const call = await docker(args, extraEnv);
		if (!call.ok) return call;
		if (call.value.status !== 0) {
			const reason = call.value.stderr.trim().split("\n")[0] ?? "";
			return fail("runner_unavailable", `docker ${args[0] ?? ""} failed: ${reason}`);
		}
		return ok(call.value.stdout);
	};

	const listObjects = async (
		kind: DockerObjectKind,
		runId: string,
	): Promise<Result<{ id: string; name: string }[], RunnerError>> => {
		const out = await dockerOk(buildListArgv(kind, runId));
		if (!out.ok) return out;
		return ok(
			out.value
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line !== "")
				.map((line) => {
					const [id = "", name = ""] = line.split(" ");
					return { id, name };
				}),
		);
	};

	const removeAll = async (
		kind: DockerObjectKind,
		runId: string,
	): Promise<Result<void, RunnerError>> => {
		const listed = await listObjects(kind, runId);
		if (!listed.ok) return fail("teardown_failed", listed.error.message);
		const foreign = listed.value.filter((object) => !object.name.startsWith("factory-"));
		if (foreign.length > 0) {
			return fail(
				"teardown_failed",
				`Refusing to remove ${foreign.length} ${kind}(s) without the factory- name prefix`,
			);
		}
		if (listed.value.length === 0) return ok(undefined);
		const removed = await dockerOk(
			buildRemoveArgv(
				kind,
				listed.value.map((object) => object.id),
			),
		);
		return removed.ok ? ok(undefined) : fail("teardown_failed", removed.error.message);
	};

	const teardown = async (runId: string): Promise<Result<void, RunnerError>> => {
		if (!isValidRunId(runId)) return fail("invalid_input", `Invalid run id: ${runId}`);
		services.delete(runId);
		const containers = await removeAll("container", runId);
		if (!containers.ok) return containers;
		return removeAll("network", runId);
	};

	const waitForPostgres = async (runId: string): Promise<Result<void, RunnerError>> => {
		const deadline = config.now() + config.readyTimeoutMs;
		const argv = buildReadyArgv(runId, DB_USER, dbName);
		if (!argv.ok) return argv;
		for (;;) {
			const call = await docker(argv.value);
			if (!call.ok) return call;
			if (call.value.status === 0) return ok(undefined);
			if (config.now() >= deadline) {
				return fail("runner_failed", "The test Postgres container did not become ready in time");
			}
			await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
		}
	};

	const startServices = async (runId: string): Promise<Result<Services, RunnerError>> => {
		const fromFailure = async (failure: RunnerError): Promise<Result<Services, RunnerError>> => {
			await teardown(runId);
			return fail(failure.code, failure.message);
		};
		const network = await dockerOk(buildNetworkCreateArgv(runId));
		if (!network.ok) return fromFailure(network.error);
		const password = randomBytes(18).toString("hex");
		const pg = buildPostgresArgv({
			runId,
			image: config.postgresImage,
			dbName,
			dbUser: DB_USER,
		});
		const started = await dockerOk(pg.argv, { POSTGRES_PASSWORD: password });
		if (!started.ok) return fromFailure(started.error);
		const ready = await waitForPostgres(runId);
		if (!ready.ok) return fromFailure(ready.error);
		return ok({
			databaseUrl: `postgresql://${DB_USER}:${password}@factory-${runId}-pg:${DB_PORT}/${dbName}`,
		});
	};

	const ensureServices = (runId: string): Promise<Result<Services, RunnerError>> => {
		const existing = services.get(runId);
		if (existing) return existing;
		const pending = startServices(runId).then((result) => {
			if (!result.ok) services.delete(runId);
			return result;
		});
		services.set(runId, pending);
		return pending;
	};

	return {
		kind: "docker",
		isolated: true,
		teardown,
		runCheck: async (input) => {
			const valid = validateRunCheckInput(input);
			if (!valid.ok) return valid;
			if (!isValidDbIdent(dbName)) return fail("invalid_input", `Invalid database name: ${dbName}`);
			const ready = await ensureServices(input.runId);
			if (!ready.ok) return ready;
			const suffix = randomBytes(4).toString("hex");
			const literalEnv = {
				NODE_ENV: "test",
				CI: "true",
				...Object.fromEntries(
					Object.entries(input.env).filter(([name]) => !RESERVED_ENV.has(name)),
				),
			};
			const argv = buildCheckArgv({
				runId: input.runId,
				suffix,
				image: config.nodeImage,
				workdir: input.cwd,
				homeDir: config.homeDir,
				user: config.user,
				command: input.argv,
				secretEnvNames: ["TEST_DATABASE_URL", "DATABASE_URL"],
				literalEnv,
			});
			if (!argv.ok) return argv;
			const checkId = input.checkId ?? config.ids("chk");
			const logPath = checkLogPath(config.factoryHome, input.runId, checkId);
			const ran = await runLogged({
				bin: config.dockerBin,
				args: argv.value,
				cwd: input.cwd,
				env: {
					...config.baseEnv,
					TEST_DATABASE_URL: ready.value.databaseUrl,
					DATABASE_URL: ready.value.databaseUrl,
				},
				timeoutMs: input.timeoutMs,
				logPath,
				killGroup: false,
				...(input.signal === undefined ? {} : { signal: input.signal }),
				onTimeout: async () => {
					const killed = await docker(buildKillArgv(checkContainerName(input.runId, suffix)));
					if (!killed.ok) return `docker kill failed: ${killed.error.message}`;
					return killed.value.status === 0
						? undefined
						: `docker kill failed (exit ${killed.value.status}): ${killed.value.stderr.trim().split("\n")[0] ?? ""}`;
				},
				now: config.now,
			});
			if (!ran.ok) return ran;
			return ok({ checkId, logPath, isolated: true, ...ran.value });
		},
	};
};
