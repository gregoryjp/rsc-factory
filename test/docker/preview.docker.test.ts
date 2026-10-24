import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NODE_IMAGE, PLAYWRIGHT_IMAGE, POSTGRES_IMAGE } from "../../src/config/compatibility.js";
import { UiEvidenceSchema } from "../../src/contracts/ui-evidence.js";
import { type PreviewPolicy, parseCheckPolicy } from "../../src/domain/checks/policy.js";
import { parseUiRoutes, type UiAuth, type UiRoute } from "../../src/domain/review/ui.js";
import { createDockerExec } from "../../src/infrastructure/runner/docker-cli.js";
import { createDockerPreview } from "../../src/infrastructure/runner/docker-preview.js";
import {
	buildPreviewListArgv,
	buildPreviewNetworkArgv,
	buildPreviewPostgresArgv,
	buildPreviewStepArgv,
	previewContainerName,
	previewNetworkName,
} from "../../src/infrastructure/runner/docker-preview-argv.js";
import { bootstrapProduct } from "../../src/modules/execution/bootstrap-product.js";
import { REPO_ROOT } from "../helpers/env.js";
import { createExecEnv, FULLSTACK, seedPlanningRun } from "../helpers/exec-env.js";
import {
	allContainerNames,
	baseEnv,
	containerUser,
	dockerAvailable,
	labeled,
	makeHomeTempDir,
	SKIP_REASON,
} from "./docker-helpers.js";

const MINUTES = 60_000;
const PNG_MAGIC = "89504e470d0a1a0a";
const TEST_PASSWORD = "test-only-Passw0rd!";

const dockerExec = createDockerExec({ dockerBin: "docker", baseEnv: baseEnv() });

const makePreview = (home: string) =>
	createDockerPreview({
		factoryHome: home,
		exec: dockerExec,
		toolsSource: join(REPO_ROOT, "factory", "preview"),
		nodeImage: NODE_IMAGE,
		postgresImage: POSTGRES_IMAGE,
		playwrightImage: PLAYWRIGHT_IMAGE,
		user: containerUser,
		homeDir: homedir(),
	});

const skeletonPolicy = (): PreviewPolicy => {
	const policy = parseCheckPolicy(
		readFileSync(join(REPO_ROOT, "factory/policies/checks.json"), "utf8"),
	);
	if (!policy.ok) throw new Error(policy.error.message);
	const preview = policy.value["fullstack-kimmbo"]?.preview;
	if (!preview) throw new Error("no preview policy");
	return preview;
};

const bootstrapSkeleton = (home: string) => {
	const exec = createExecEnv(home);
	const { runId, target } = seedPlanningRun(exec.env, {
		presetIds: FULLSTACK,
		target: join(makeHomeTempDir(), "product"),
		projectName: "turno-local",
	});
	const boot = bootstrapProduct(exec.deps, { runId });
	if (!boot.ok) throw new Error(`${boot.error.code}: ${boot.error.message}`);
	const commit = boot.value.commitSha;
	const productDir = join(makeHomeTempDir(), "snapshot");
	const snap = exec.git.snapshot(target, commit, productDir);
	if (!snap.ok) throw new Error(snap.error.message);
	return { runId, commit, productDir };
};

const LOGIN_PAGE = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ingresar</title></head>
<body><main><h1>Ingresar</h1>
<form id="f"><label for="u">Correo</label><input id="u" type="email" autocomplete="username"><label for="p">Contraseña</label><input id="p" type="password" autocomplete="current-password"><button type="submit">Entrar</button></form>
<div id="msg"></div></main>
<script>
document.getElementById("f").addEventListener("submit", async (event) => {
  event.preventDefault();
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: document.getElementById("u").value, password: document.getElementById("p").value }),
  });
  if (response.ok) { location.href = "/tickets"; return; }
  document.getElementById("msg").innerHTML = '<p role="alert">Credenciales invalidas</p>';
});
</script></body></html>
`;

const TICKETS_PAGE = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tickets</title></head>
<body><main><h1>Tickets</h1><p id="who">Cargando</p></main>
<script>
fetch("/api/auth/me").then(async (response) => {
  if (!response.ok) { location.replace("/login"); return; }
  const me = await response.json();
  document.getElementById("who").textContent = "Sesion de " + me.email;
});
</script></body></html>
`;

const FORBIDDEN_PAGE = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Backoffice</title></head>
<body><main><h1>Backoffice</h1></main><script>location.replace("/");</script></body></html>
`;

const FIXTURE_SERVER = `import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const sessions = new Map();

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  if (req.url === "/health/ready") {
    try {
      await prisma.$queryRawUnsafe("SELECT 1");
      return send(res, 200, { ok: true });
    } catch {
      return send(res, 503, { ok: false });
    }
  }
  if (req.url === "/auth/login" && req.method === "POST") {
    const { email, password } = JSON.parse((await readBody(req)) || "{}");
    const rows = await prisma.$queryRawUnsafe(
      'SELECT email FROM "TestUser" WHERE email = $1 AND password = $2',
      String(email),
      String(password),
    );
    if (rows.length === 0) return send(res, 401, { error: "invalid" });
    const sid = randomUUID();
    sessions.set(sid, rows[0].email);
    return send(res, 200, { ok: true }, { "set-cookie": "sid=" + sid + "; HttpOnly; Path=/; SameSite=Lax" });
  }
  if (req.url === "/auth/me") {
    const sid = /(?:^|; )sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "";
    const email = sessions.get(sid);
    return email ? send(res, 200, { email }) : send(res, 401, { error: "anonymous" });
  }
  return send(res, 404, { error: "not found" });
}).listen(Number(process.env.PORT), "0.0.0.0");
`;

const FIXTURE_SEED = `import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
await prisma.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS "TestUser" (email TEXT PRIMARY KEY, password TEXT NOT NULL)');
await prisma.$executeRawUnsafe('INSERT INTO "TestUser" (email, password) VALUES ($1, $2)', "admin@test.local", "${TEST_PASSWORD}");
await prisma.$disconnect();
`;

const write = (root: string, path: string, content: string): void => {
	const file = join(root, path);
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, content);
};

const FIXTURE_AUTH: UiAuth = {
	loginPath: "/login",
	fields: { username: "Correo", password: "Contraseña" },
	submit: "Entrar",
	accounts: {
		admin: { username: "admin@test.local", password: TEST_PASSWORD },
		intruso: { username: "admin@test.local", password: "wrong-Passw0rd-12345" },
	},
};

const newRunId = (): string => `run_${randomBytes(4).toString("hex")}`;

const cleanLabeled = (runId: string): void => {
	for (const kind of ["container", "network"] as const) {
		const listed = labeled(kind === "container" ? "ps" : "network", runId);
		expect(listed.every((name) => name.startsWith("factory-"))).toBe(true);
	}
};

describe.skipIf(!dockerAvailable)(
	`browser evidence acceptance (${dockerAvailable ? "real Docker + Playwright" : SKIP_REASON})`,
	() => {
		it(
			"previews the fullstack-kimmbo skeleton with postgres, migrate, api and the /api proxy: two PNGs, axe ran, no overflow, objects cleaned",
			async () => {
				const home = makeHomeTempDir();
				const { runId, commit, productDir } = bootstrapSkeleton(home);
				const preview = skeletonPolicy();
				expect(preview.api).toBeDefined();
				const routes = parseUiRoutes(readFileSync(join(productDir, "web/ui-routes.json"), "utf8"));
				if (!routes.ok) throw new Error(routes.error.message);
				const before = allContainerNames().filter((name) => name.startsWith("kimmbo-prod-"));
				const outDir = join(home, "runs", runId, "ui", commit);
				const started = Date.now();
				const outcome = await makePreview(home).capture({
					runId,
					commitSha: commit,
					productDir,
					policy: preview,
					routes: routes.value,
					auth: null,
					outDir,
				});
				console.info(`skeleton preview capture took ${Math.round((Date.now() - started) / 1000)}s`);
				if (outcome.status !== "captured") throw new Error(`unavailable: ${outcome.reason}`);

				expect(UiEvidenceSchema.safeParse(outcome.evidence).success).toBe(true);
				expect(outcome.evidence.commitSha).toBe(commit);
				expect(outcome.evidence.pages.map((p) => p.viewport.width).sort((a, b) => a - b)).toEqual([
					390, 1440,
				]);
				for (const page of outcome.evidence.pages) {
					if (page.status !== "captured") throw new Error(`unexpected ${page.status}`);
					expect(page.as).toBeNull();
					expect(page.authenticated).toBe(false);
					const file = join(outDir, page.screenshot.path);
					expect(statSync(file).size).toBeGreaterThan(1000);
					expect(readFileSync(file).subarray(0, 8).toString("hex")).toBe(PNG_MAGIC);
					expect(Array.isArray(page.axe.violations)).toBe(true);
					expect(page.overflow.overflows).toBe(false);
				}
				expect(existsSync(join(outDir, "ui-evidence.json"))).toBe(true);
				expect(outcome.teardownError).toBeNull();
				expect(labeled("ps", runId)).toEqual([]);
				expect(labeled("network", runId)).toEqual([]);
				expect(allContainerNames().filter((name) => name.startsWith("kimmbo-prod-"))).toEqual(
					before,
				);
			},
			45 * MINUTES,
		);

		it(
			"captures an authenticated screen end to end through the /api proxy, and marks a wrong password unavailable",
			async () => {
				const home = makeHomeTempDir();
				const { runId, commit, productDir } = bootstrapSkeleton(home);
				write(productDir, "web/public/login/index.html", LOGIN_PAGE);
				write(productDir, "web/public/tickets/index.html", TICKETS_PAGE);
				write(productDir, "web/public/backoffice/index.html", FORBIDDEN_PAGE);
				write(productDir, "api/fixture-server.mjs", FIXTURE_SERVER);
				write(productDir, "api/fixture-seed.mjs", FIXTURE_SEED);
				const base = skeletonPolicy();
				const policy: PreviewPolicy = {
					install: base.install,
					...(base.build ? { build: base.build } : {}),
					staticDir: base.staticDir,
					api: {
						seed: ["node", "api/fixture-seed.mjs"],
						start: ["node", "api/fixture-server.mjs"],
						port: 3000,
						healthPath: "/health/ready",
					},
				};
				const routes: UiRoute[] = [
					{ path: "/login", as: null },
					{ path: "/tickets", as: "admin" },
					{ path: "/tickets", as: "intruso" },
					{ path: "/backoffice", as: "admin" },
				];
				const outDir = join(home, "runs", runId, "ui", commit);
				const started = Date.now();
				const outcome = await makePreview(home).capture({
					runId,
					commitSha: commit,
					productDir,
					policy,
					routes,
					auth: FIXTURE_AUTH,
					outDir,
				});
				console.info(
					`authenticated preview capture took ${Math.round((Date.now() - started) / 1000)}s`,
				);
				if (outcome.status !== "captured") throw new Error(`unavailable: ${outcome.reason}`);

				const summary = outcome.evidence.pages.map((p) => [
					p.route,
					p.as,
					p.status,
					p.authenticated,
				]);
				expect(summary).toEqual([
					["/login", null, "captured", false],
					["/login", null, "captured", false],
					["/tickets", "admin", "captured", true],
					["/tickets", "admin", "captured", true],
					["/tickets", "intruso", "unavailable", false],
					["/tickets", "intruso", "unavailable", false],
					["/backoffice", "admin", "unavailable", false],
					["/backoffice", "admin", "unavailable", false],
				]);
				const redirected = outcome.evidence.pages.find((p) => p.route === "/backoffice");
				expect(redirected?.status === "unavailable" && redirected.reason).toContain(
					"redirected away",
				);
				const names = outcome.evidence.pages.flatMap((p) =>
					p.status === "captured" ? [p.screenshot.path] : [],
				);
				expect(new Set(names).size).toBe(names.length);
				expect(names.some((name) => name.includes("intruso"))).toBe(false);
				const intruso = outcome.evidence.pages.find((p) => p.as === "intruso");
				expect(intruso?.status === "unavailable" && intruso.reason).toContain("login failed");
				const evidenceText = readFileSync(outcome.evidencePath, "utf8");
				expect(evidenceText).not.toContain(TEST_PASSWORD);
				expect(evidenceText).not.toContain("wrong-Passw0rd");
				expect(outcome.teardownError).toBeNull();
				expect(labeled("ps", runId)).toEqual([]);
				expect(labeled("network", runId)).toEqual([]);
			},
			45 * MINUTES,
		);

		it(
			"rejects a static dir that the build replaced with a symlink to a host path, without serving it",
			async () => {
				const home = makeHomeTempDir();
				const productDir = join(makeHomeTempDir(), "snapshot");
				mkdirSync(join(productDir, "dist"), { recursive: true });
				const runId = newRunId();
				const outcome = await makePreview(home).capture({
					runId,
					commitSha: "d".repeat(40),
					productDir,
					policy: {
						install: ["node", "-e", "0"],
						build: [
							"node",
							"-e",
							"const fs=require('fs');fs.rmSync('dist',{recursive:true,force:true});fs.symlinkSync('/etc','dist')",
						],
						staticDir: "dist",
					},
					routes: [{ path: "/", as: null }],
					auth: null,
					outDir: join(home, "runs", runId, "ui", "d".repeat(40)),
				});
				expect(outcome.status).toBe("unavailable");
				if (outcome.status === "unavailable") expect(outcome.reason).toContain("symbolic link");
				expect(labeled("ps", runId)).toEqual([]);
				expect(labeled("network", runId)).toEqual([]);
			},
			15 * MINUTES,
		);

		it(
			"the runtime network is internal: containers reach postgres but nothing outside",
			async () => {
				const runId = newRunId();
				const pid = `pv${randomBytes(3).toString("hex")}`;
				const workdir = makeHomeTempDir();
				const probe = [
					"const net=require('net');",
					"const tryConnect=(host,port)=>new Promise((done)=>{",
					"const socket=net.connect({host,port,timeout:4000});",
					"socket.on('connect',()=>{socket.destroy();done(true)});",
					"socket.on('timeout',()=>{socket.destroy();done(false)});",
					"socket.on('error',()=>done(false));});",
					`(async()=>{console.log(JSON.stringify({pg:await tryConnect('${previewContainerName(runId, pid, "pg")}',5432),external:await tryConnect('1.1.1.1',443)}))})();`,
				].join("");
				const step = (network: "internal" | "egress", suffix: string) => {
					const argv = buildPreviewStepArgv({
						runId,
						pid,
						suffix,
						network,
						image: NODE_IMAGE,
						workdir,
						homeDir: homedir(),
						user: containerUser,
						command: ["node", "-e", probe],
						secretEnvNames: [],
						literalEnv: {},
					});
					if (!argv.ok) throw new Error(argv.error.message);
					return argv.value;
				};
				const call = async (argv: string[], env: Record<string, string> = {}) => {
					const called = await dockerExec(argv, { env, timeoutMs: 120_000 });
					if (!called.ok) throw new Error(called.error.message);
					return called.value;
				};
				try {
					for (const kind of ["egress", "internal"] as const) {
						expect((await call(buildPreviewNetworkArgv(runId, pid, kind))).status).toBe(0);
					}
					const pg = buildPreviewPostgresArgv({
						runId,
						pid,
						image: POSTGRES_IMAGE,
						dbName: "preview",
						dbUser: "factory",
					});
					expect((await call(pg.argv, { POSTGRES_PASSWORD: "probe-only-secret" })).status).toBe(0);
					const ready = [
						"exec",
						previewContainerName(runId, pid, "pg"),
						"pg_isready",
						"-h",
						"127.0.0.1",
						"-U",
						"factory",
						"-d",
						"preview",
					];
					for (let attempt = 0; attempt < 60; attempt += 1) {
						if ((await call(ready)).status === 0) break;
						await new Promise((done) => setTimeout(done, 1000));
					}
					const internal = await call(step("internal", "probe-int"));
					expect(internal.status, internal.stderr).toBe(0);
					expect(JSON.parse(internal.stdout.trim().split("\n").at(-1) ?? "{}")).toEqual({
						pg: true,
						external: false,
					});
					const egress = await call(step("egress", "probe-net"));
					console.info(`egress control (no postgres on that network): ${egress.stdout.trim()}`);
					expect(previewNetworkName(runId, pid, "internal")).toContain("-int");
				} finally {
					for (const kind of ["container", "network"] as const) {
						const listed = await call(buildPreviewListArgv(kind, runId, pid));
						const ids = listed.stdout
							.split("\n")
							.map((line) => line.trim().split(" ")[0] ?? "")
							.filter((id) => id !== "");
						if (ids.length > 0) {
							await call(
								kind === "container" ? ["rm", "-f", "-v", ...ids] : ["network", "rm", ...ids],
							);
						}
					}
				}
				cleanLabeled(runId);
				expect(labeled("ps", runId)).toEqual([]);
				expect(labeled("network", runId)).toEqual([]);
			},
			10 * MINUTES,
		);
	},
);
