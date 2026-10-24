import { createHash, randomBytes } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { AXE_VERSION, PLAYWRIGHT_VERSION } from "../../config/compatibility.js";
import {
	RawCaptureSchema,
	UI_VIEWPORTS,
	type UiEvidence,
	UiEvidenceSchema,
} from "../../contracts/ui-evidence.js";
import type { PreviewPolicy } from "../../domain/checks/policy.js";
import type { PreviewOutcome, PreviewPort, PreviewRequest } from "../../modules/execution/ports.js";
import { type Failure, fail, ok, type Result } from "../../shared/result.js";
import type { DockerExec } from "./docker-cli.js";
import {
	buildPlaywrightArgv,
	buildPreviewListArgv,
	buildPreviewNetworkArgv,
	buildPreviewPostgresArgv,
	buildPreviewServiceArgv,
	buildPreviewStepArgv,
	type PreviewNetworkKind,
	previewContainerName,
} from "./docker-preview-argv.js";

const TOOL_FILES = [
	"capture.mjs",
	"names.mjs",
	"static-server.mjs",
	"package.json",
	"package-lock.json",
];
const NETWORK_KINDS: readonly PreviewNetworkKind[] = ["egress", "internal"];
const WEB_PORT = 4173;
const DB_NAME = "preview";
const DB_USER = "factory";
const DB_PORT = 5432;
const STEP_TIMEOUT_MS = 600_000;
const SERVICE_TIMEOUT_MS = 60_000;
const CAPTURE_TIMEOUT_MS = 300_000;
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 500;
const EXIT_UNREACHABLE = 3;
const EVIDENCE_FILE = "ui-evidence.json";
const RAW_FILE = "raw-capture.json";

export type DockerPreviewConfig = {
	factoryHome: string;
	exec: DockerExec;
	toolsSource: string;
	nodeImage: string;
	postgresImage: string;
	playwrightImage: string;
	user: { uid: number; gid: number };
	homeDir: string;
	newPreviewId?: () => string;
	newSecret?: () => string;
};

type Stop = Failure<"unavailable">;

const unavailable = (message: string): Result<never, Stop> => fail("unavailable", message);

const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

const firstLine = (text: string): string => text.trim().split("\n").at(-1)?.slice(0, 300) ?? "";

const isInside = (child: string, parent: string): boolean => {
	const rel = relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
};

export const createDockerPreview = (config: DockerPreviewConfig): PreviewPort => {
	const newPreviewId = config.newPreviewId ?? (() => `pv${randomBytes(3).toString("hex")}`);
	const newSecret = config.newSecret ?? (() => randomBytes(18).toString("hex"));

	const sourceHash = (): { scriptSha256: string; toolsKey: string; fileHashes: string[] } => {
		const contents = TOOL_FILES.map((name) => readFileSync(join(config.toolsSource, name)));
		const script = contents[0] ?? Buffer.alloc(0);
		return {
			scriptSha256: sha256(script),
			toolsKey: sha256(Buffer.concat(contents)).slice(0, 16),
			fileHashes: contents.map((content) => sha256(content)),
		};
	};

	const verifyTools = (dir: string, fileHashes: readonly string[]): Result<string, Stop> => {
		for (const [index, name] of TOOL_FILES.entries()) {
			const file = join(dir, name);
			const actual = existsSync(file) ? sha256(readFileSync(file)) : "";
			if (actual !== fileHashes[index]) {
				return unavailable(`tool cache does not match the engine source (${name})`);
			}
		}
		return ok(dir);
	};

	const run = async (
		label: string,
		argv: Result<string[], { message: string }>,
		options: { env?: Record<string, string>; timeoutMs?: number } = {},
	): Promise<Result<string, Stop>> => {
		if (!argv.ok) return unavailable(`${label}: ${argv.error.message}`);
		const called = await config.exec(argv.value, {
			env: options.env ?? {},
			timeoutMs: options.timeoutMs ?? STEP_TIMEOUT_MS,
		});
		if (!called.ok) return unavailable(`${label}: ${called.error.message}`);
		if (called.value.status !== 0) {
			return unavailable(
				`${label} failed (exit ${called.value.status}): ${firstLine(called.value.stderr)} ${called.value.stdout.trim().slice(-300)}`.trim(),
			);
		}
		return ok(called.value.stdout);
	};

	const prepareTools = async (
		runId: string,
		pid: string,
		toolsKey: string,
		fileHashes: readonly string[],
	): Promise<Result<string, Stop>> => {
		const dir = join(config.factoryHome, "preview-tools", toolsKey);
		if (existsSync(join(dir, "node_modules", "playwright-core"))) {
			return verifyTools(dir, fileHashes);
		}
		mkdirSync(dir, { recursive: true });
		for (const name of TOOL_FILES) copyFileSync(join(config.toolsSource, name), join(dir, name));
		const installed = await run(
			"tools install",
			buildPreviewStepArgv({
				runId,
				pid,
				suffix: "tools",
				network: "egress",
				image: config.nodeImage,
				workdir: dir,
				homeDir: config.homeDir,
				user: config.user,
				command: ["npm", "ci", "--ignore-scripts"],
				secretEnvNames: [],
				literalEnv: {},
			}),
		);
		if (!installed.ok) return installed;
		if (!existsSync(join(dir, "node_modules", "playwright-core"))) {
			return unavailable("tools install did not produce playwright-core");
		}
		return verifyTools(dir, fileHashes);
	};

	const productStep = (
		request: PreviewRequest,
		pid: string,
		label: string,
		command: readonly string[],
		network: PreviewNetworkKind,
		env: { secret?: string } = {},
	): Promise<Result<string, Stop>> =>
		run(
			label,
			buildPreviewStepArgv({
				runId: request.runId,
				pid,
				suffix: label,
				network,
				image: config.nodeImage,
				workdir: request.productDir,
				homeDir: config.homeDir,
				user: config.user,
				command,
				secretEnvNames: env.secret === undefined ? [] : ["DATABASE_URL"],
				literalEnv: { CI: "true" },
			}),
			env.secret === undefined ? {} : { env: { DATABASE_URL: env.secret } },
		);

	const waitForPostgres = async (runId: string, pid: string): Promise<Result<void, Stop>> => {
		const deadline = Date.now() + READY_TIMEOUT_MS;
		const argv = [
			"exec",
			previewContainerName(runId, pid, "pg"),
			"pg_isready",
			"-h",
			"127.0.0.1",
			"-U",
			DB_USER,
			"-d",
			DB_NAME,
		];
		for (;;) {
			const called = await config.exec(argv);
			if (!called.ok) return unavailable(`postgres readiness: ${called.error.message}`);
			if (called.value.status === 0) return ok(undefined);
			if (Date.now() >= deadline) return unavailable("postgres did not become ready in time");
			await new Promise((done) => setTimeout(done, READY_POLL_MS));
		}
	};

	const serviceUrl = (request: PreviewRequest, pid: string, role: "web" | "api", port: number) =>
		`http://${previewContainerName(request.runId, pid, role)}:${port}`;

	const startApi = async (
		request: PreviewRequest,
		pid: string,
		api: NonNullable<PreviewPolicy["api"]>,
	): Promise<Result<string, Stop>> => {
		const password = newSecret();
		const pg = buildPreviewPostgresArgv({
			runId: request.runId,
			pid,
			image: config.postgresImage,
			dbName: DB_NAME,
			dbUser: DB_USER,
		});
		const started = await run("postgres", ok(pg.argv), {
			env: { POSTGRES_PASSWORD: password },
			timeoutMs: SERVICE_TIMEOUT_MS,
		});
		if (!started.ok) return started;
		const ready = await waitForPostgres(request.runId, pid);
		if (!ready.ok) return ready;
		const databaseUrl = `postgresql://${DB_USER}:${password}@${previewContainerName(request.runId, pid, "pg")}:${DB_PORT}/${DB_NAME}`;
		for (const [label, command] of [
			["migrate", api.migrate],
			["seed", api.seed],
		] as const) {
			if (command === undefined) continue;
			const stepped = await productStep(request, pid, label, command, "internal", {
				secret: databaseUrl,
			});
			if (!stepped.ok) return stepped;
		}
		const service = await run(
			"api start",
			buildPreviewServiceArgv({
				runId: request.runId,
				pid,
				role: "api",
				image: config.nodeImage,
				homeDir: config.homeDir,
				user: config.user,
				mounts: [{ source: request.productDir, target: "/work", readOnly: true }],
				workdir: "/work",
				command: api.start,
				secretEnvNames: ["DATABASE_URL"],
				literalEnv: {
					NODE_ENV: "production",
					PORT: String(api.port),
					CORS_ORIGINS: serviceUrl(request, pid, "web", WEB_PORT),
				},
			}),
			{ env: { DATABASE_URL: databaseUrl }, timeoutMs: SERVICE_TIMEOUT_MS },
		);
		return service.ok
			? ok(`${serviceUrl(request, pid, "api", api.port)}${api.healthPath}`)
			: service;
	};

	const resolveStaticDir = (request: PreviewRequest): Result<string, Stop> => {
		const root = realpathSync(request.productDir);
		const lexical = resolve(root, request.policy.staticDir);
		if (!isInside(lexical, root)) return unavailable("staticDir escapes the product snapshot");
		const shown = request.policy.staticDir;
		let entry: ReturnType<typeof lstatSync>;
		try {
			entry = lstatSync(lexical);
		} catch {
			return unavailable(`static directory ${shown} was not produced`);
		}
		if (entry.isSymbolicLink()) return unavailable(`static directory ${shown} is a symbolic link`);
		if (!entry.isDirectory()) return unavailable(`static directory ${shown} was not produced`);
		const real = realpathSync(lexical);
		return isInside(real, root)
			? ok(real)
			: unavailable(`static directory ${shown} resolves outside the snapshot`);
	};

	const startWeb = async (
		request: PreviewRequest,
		pid: string,
		toolsDir: string,
		apiBase: string | null,
	): Promise<Result<string, Stop>> => {
		const siteDir = resolveStaticDir(request);
		if (!siteDir.ok) return siteDir;
		const service = await run(
			"web start",
			buildPreviewServiceArgv({
				runId: request.runId,
				pid,
				role: "web",
				image: config.nodeImage,
				homeDir: config.homeDir,
				user: config.user,
				mounts: [
					{ source: siteDir.value, target: "/site", readOnly: true },
					{ source: toolsDir, target: "/tool", readOnly: true },
				],
				command: ["node", "/tool/static-server.mjs", "/site", String(WEB_PORT)],
				secretEnvNames: [],
				literalEnv: apiBase === null ? {} : { API_UPSTREAM: apiBase },
			}),
			{ timeoutMs: SERVICE_TIMEOUT_MS },
		);
		return service.ok ? ok(serviceUrl(request, pid, "web", WEB_PORT)) : service;
	};

	const collectEvidence = (
		request: PreviewRequest,
		scriptSha256: string,
	): Result<UiEvidence, Stop> => {
		const rawPath = join(request.outDir, RAW_FILE);
		if (!existsSync(rawPath)) return unavailable("the capture script produced no output");
		let raw: ReturnType<typeof RawCaptureSchema.safeParse>;
		try {
			raw = RawCaptureSchema.safeParse(JSON.parse(readFileSync(rawPath, "utf8")));
		} catch {
			return unavailable("the capture output is not valid JSON");
		}
		if (!raw.success)
			return unavailable(`the capture output is malformed: ${raw.error.message.slice(0, 200)}`);
		const keyOf = (path: string, as: string | null, width: number): string =>
			`${path}|${as ?? ""}|${width}`;
		const expected = new Set(
			request.routes.flatMap((route) =>
				UI_VIEWPORTS.map((vp) => keyOf(route.path, route.as, vp.width)),
			),
		);
		const seen = new Set(
			raw.data.pages.map((page) => keyOf(page.route, page.as, page.viewport.width)),
		);
		const missing = [...expected].filter((key) => !seen.has(key));
		const extra = [...seen].filter((key) => !expected.has(key));
		if (missing.length > 0 || extra.length > 0 || seen.size !== raw.data.pages.length) {
			return unavailable(
				`the capture is incomplete or duplicated (missing: ${missing.join(", ") || "none"})`,
			);
		}
		const pages: UiEvidence["pages"] = [];
		for (const page of raw.data.pages) {
			if (page.status === "unavailable") {
				pages.push(page);
				continue;
			}
			const file = join(request.outDir, page.screenshot.path);
			const bytes = existsSync(file) ? readFileSync(file) : Buffer.alloc(0);
			if (bytes.length === 0) {
				return unavailable(`empty or missing screenshot ${page.screenshot.path}`);
			}
			pages.push({
				...page,
				screenshot: { path: page.screenshot.path, sha256: sha256(bytes), bytes: bytes.length },
			});
		}
		const evidence = UiEvidenceSchema.safeParse({
			schemaVersion: 1,
			commitSha: request.commitSha,
			scriptSha256,
			playwrightVersion: PLAYWRIGHT_VERSION,
			axeVersion: AXE_VERSION,
			pages,
		});
		return evidence.success
			? ok(evidence.data)
			: unavailable(`the evidence failed validation: ${evidence.error.message.slice(0, 200)}`);
	};

	const teardown = async (runId: string, pid: string): Promise<string | null> => {
		const errors: string[] = [];
		for (const kind of ["container", "network"] as const) {
			const listed = await config.exec(buildPreviewListArgv(kind, runId, pid));
			if (!listed.ok || listed.value.status !== 0) {
				errors.push(`${kind} list failed`);
				continue;
			}
			const objects = listed.value.stdout
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line !== "")
				.map((line) => {
					const [id = "", name = ""] = line.split(" ");
					return { id, name };
				});
			if (objects.some((object) => !object.name.startsWith("factory-"))) {
				errors.push(`${kind}: refusing to remove an object without the factory- prefix`);
				continue;
			}
			if (objects.length === 0) continue;
			const ids = objects.map((object) => object.id);
			const removed = await config.exec(
				kind === "container" ? ["rm", "-f", "-v", ...ids] : ["network", "rm", ...ids],
			);
			if (!removed.ok || removed.value.status !== 0) errors.push(`${kind} removal failed`);
		}
		return errors.length === 0 ? null : errors.join("; ");
	};

	const browserAuth = (request: PreviewRequest): string | null => {
		const roles = [
			...new Set(request.routes.flatMap((route) => (route.as === null ? [] : [route.as]))),
		];
		if (request.auth === null || roles.length === 0) return null;
		const accounts = Object.fromEntries(
			roles.flatMap((role) => {
				const account = request.auth?.accounts[role];
				return account === undefined ? [] : [[role, account]];
			}),
		);
		return JSON.stringify({ ...request.auth, accounts });
	};

	const execute = async (
		original: PreviewRequest,
		pid: string,
	): Promise<Result<UiEvidence, Stop>> => {
		const { scriptSha256, toolsKey, fileHashes } = sourceHash();
		const request = { ...original, productDir: realpathSync(original.productDir) };
		for (const kind of NETWORK_KINDS) {
			const network = await run("network", ok(buildPreviewNetworkArgv(request.runId, pid, kind)), {
				timeoutMs: SERVICE_TIMEOUT_MS,
			});
			if (!network.ok) return network;
		}
		const tools = await prepareTools(request.runId, pid, toolsKey, fileHashes);
		if (!tools.ok) return tools;
		const installed = await productStep(request, pid, "install", request.policy.install, "egress");
		if (!installed.ok) return installed;
		if (request.policy.build !== undefined) {
			const built = await productStep(request, pid, "build", request.policy.build, "egress");
			if (!built.ok) return built;
		}
		const waits: string[] = [];
		const apiPolicy = request.policy.api;
		if (apiPolicy !== undefined) {
			if (apiPolicy.build !== undefined) {
				const built = await productStep(request, pid, "api-build", apiPolicy.build, "egress");
				if (!built.ok) return built;
			}
			const api = await startApi(request, pid, apiPolicy);
			if (!api.ok) return api;
			waits.push(api.value);
		}
		const web = await startWeb(
			request,
			pid,
			tools.value,
			apiPolicy === undefined ? null : serviceUrl(request, pid, "api", apiPolicy.port),
		);
		if (!web.ok) return web;
		rmSync(request.outDir, { recursive: true, force: true });
		mkdirSync(join(request.outDir, "shots"), { recursive: true });
		const auth = browserAuth(request);
		const browser = buildPlaywrightArgv({
			runId: request.runId,
			pid,
			image: config.playwrightImage,
			toolDir: tools.value,
			outDir: request.outDir,
			homeDir: config.homeDir,
			user: config.user,
			literalEnv: {
				BASE_URL: web.value,
				ROUTES: JSON.stringify(request.routes),
				WAIT_URLS: JSON.stringify([web.value, ...waits]),
			},
			secretEnvNames: auth === null ? [] : ["AUTH"],
		});
		if (!browser.ok) return unavailable(browser.error.message);
		const captured = await config.exec(browser.value, {
			timeoutMs: CAPTURE_TIMEOUT_MS,
			...(auth === null ? {} : { env: { AUTH: auth } }),
		});
		if (!captured.ok) return unavailable(`browser capture: ${captured.error.message}`);
		if (captured.value.status === EXIT_UNREACHABLE) {
			return unavailable(`the app did not answer in time: ${firstLine(captured.value.stderr)}`);
		}
		if (captured.value.status !== 0) {
			return unavailable(
				`browser capture failed (exit ${captured.value.status}): ${firstLine(captured.value.stderr)}`,
			);
		}
		const evidence = collectEvidence(request, scriptSha256);
		if (!evidence.ok) return evidence;
		writeFileSync(
			join(request.outDir, EVIDENCE_FILE),
			`${JSON.stringify(evidence.value, null, 2)}\n`,
		);
		rmSync(join(request.outDir, RAW_FILE), { force: true });
		return evidence;
	};

	return {
		capture: async (request): Promise<PreviewOutcome> => {
			const pid = newPreviewId();
			let result: Result<UiEvidence, Stop> = unavailable("preview did not run");
			let teardownError: string | null = null;
			try {
				result = await execute(request, pid);
			} catch (error) {
				result = unavailable(error instanceof Error ? error.message : "unexpected preview failure");
			} finally {
				teardownError = await teardown(request.runId, pid);
			}
			return result.ok
				? {
						status: "captured",
						evidence: result.value,
						evidencePath: join(request.outDir, EVIDENCE_FILE),
						teardownError,
					}
				: { status: "unavailable", reason: result.error.message };
		},
	};
};
