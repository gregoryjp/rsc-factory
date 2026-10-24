import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NODE_IMAGE, PLAYWRIGHT_IMAGE, POSTGRES_IMAGE } from "../src/config/compatibility.js";
import { UiEvidenceSchema } from "../src/contracts/ui-evidence.js";
import type { PreviewPolicy } from "../src/domain/checks/policy.js";
import type { UiAuth, UiRoute } from "../src/domain/review/ui.js";
import type { DockerCall, DockerExec } from "../src/infrastructure/runner/docker-cli.js";
import { createDockerPreview } from "../src/infrastructure/runner/docker-preview.js";
import { fail, ok } from "../src/shared/result.js";
import { makeTempDir } from "./helpers/env.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const TOOLS_SOURCE = join(REPO_ROOT, "factory", "preview");
const RUN = "run_0f1e2d3c";
const COMMIT = "c".repeat(40);
const PNG = Buffer.from("89504e470d0a1a0a00", "hex");

const WEB_POLICY: PreviewPolicy = {
	install: ["npm", "ci"],
	build: ["npm", "run", "build", "-w", "web"],
	staticDir: "web/dist",
};

const API_POLICY: PreviewPolicy = {
	...WEB_POLICY,
	api: {
		build: ["npm", "run", "build", "-w", "api"],
		migrate: ["npx", "prisma", "migrate", "deploy"],
		seed: ["npm", "run", "seed", "-w", "api"],
		start: ["npm", "run", "start", "-w", "api"],
		port: 3000,
		healthPath: "/health",
	},
};

const TWO_PUBLIC: UiRoute[] = [
	{ path: "/", as: null },
	{ path: "/login", as: null },
];
const PUBLIC_ROOT: UiRoute[] = [{ path: "/", as: null }];

const shotOf = (index: number, as: string | null, width: number): string =>
	`shots/${index}-r-${as ?? "public"}-${width}x800.png`;

const rawFor = (routes: UiRoute[], unavailableRoles: string[] = []) => ({
	pages: routes.flatMap((route, index) =>
		[390, 1440].map((width) => {
			const base = {
				route: route.path,
				as: route.as,
				viewport: { name: width === 390 ? "mobile" : "desktop", width, height: 800 },
			};
			if (route.as !== null && unavailableRoles.includes(route.as)) {
				return {
					...base,
					status: "unavailable",
					authenticated: false,
					reason: `login failed for role ${route.as}`,
				};
			}
			return {
				...base,
				status: "captured",
				authenticated: route.as !== null,
				screenshot: { path: shotOf(index, route.as, width) },
				axe: { violations: [] },
				overflow: { scrollWidth: width, clientWidth: width, overflows: false },
				focus: { checked: 1, withoutIndicator: [] },
				consoleErrors: [],
			};
		}),
	),
});

type Fake = {
	exec: DockerExec;
	calls: string[][];
	envs: Record<string, string>[];
	live: () => { containers: string[]; networks: string[] };
};

const argValue = (argv: readonly string[], flag: string): string | undefined => {
	const index = argv.indexOf(flag);
	return index === -1 ? undefined : argv[index + 1];
};

const mountSources = (argv: readonly string[]): string[] =>
	argv.flatMap((arg, i) =>
		argv[i - 1] === "--mount" ? [/source=([^,]+)/.exec(arg)?.[1] ?? ""] : [],
	);

const makeFake = (
	options: {
		failOn?: (argv: readonly string[]) => DockerCall | undefined;
		writeCapture?: (outDir: string) => void;
		dockerMissing?: boolean;
		failTeardown?: boolean;
		onRun?: (argv: readonly string[]) => void;
	} = {},
): Fake => {
	const containers = new Map<string, boolean>();
	const networks = new Set<string>();
	const calls: string[][] = [];
	const envs: Record<string, string>[] = [];
	const exec: DockerExec = async (args, execOptions) => {
		calls.push([...args]);
		envs.push({ ...(execOptions?.env ?? {}) });
		if (options.dockerMissing) return fail("runner_unavailable", "docker not found");
		const done = (status = 0, stderr = "", stdout = ""): ReturnType<DockerExec> =>
			Promise.resolve(ok({ status, stdout, stderr }));
		const forced = options.failOn?.(args);
		if (forced) return ok(forced);
		const verb = args[0];
		if (verb === "network" && args[1] === "create") {
			networks.add(args.at(-1) ?? "");
			return done();
		}
		if (verb === "network" && args[1] === "ls") {
			return done(0, "", [...networks].map((n) => `net_${n} ${n}`).join("\n"));
		}
		if (verb === "network" && args[1] === "rm") {
			if (options.failTeardown) return done(1, "network busy");
			for (const id of args.slice(2)) networks.delete(id.replace("net_", ""));
			return done();
		}
		if (verb === "ps") {
			return done(0, "", [...containers.keys()].map((n) => `id_${n} ${n}`).join("\n"));
		}
		if (verb === "rm") {
			for (const id of args.slice(3)) containers.delete(id.replace("id_", ""));
			return done();
		}
		if (verb === "exec") return done();
		if (verb === "run") {
			const name = argValue(args, "--name") ?? "";
			options.onRun?.(args);
			if (args.includes("-d")) containers.set(name, true);
			if (args.includes("npm") && args.includes("ci") && name.includes("step")) {
				const tools = mountSources(args).find((source) => source.includes("preview-tools"));
				if (tools) mkdirSync(join(tools, "node_modules", "playwright-core"), { recursive: true });
			}
			if (name.endsWith("-pw")) {
				const out = mountSources(args)[1] ?? "";
				options.writeCapture?.(out);
			}
			return done();
		}
		return done();
	};
	return {
		exec,
		calls,
		envs,
		live: () => ({ containers: [...containers.keys()], networks: [...networks] }),
	};
};

const makeFakeWithBuild = (afterBuild: () => void): Fake =>
	makeFake({
		writeCapture: writeGoodCapture(PUBLIC_ROOT),
		onRun: (argv) => {
			if (argValue(argv, "--name")?.endsWith("-step-build")) afterBuild();
		},
	});

const writeGoodCapture =
	(routes: UiRoute[], unavailableRoles: string[] = []) =>
	(out: string) => {
		mkdirSync(join(out, "shots"), { recursive: true });
		const raw = rawFor(routes, unavailableRoles);
		for (const page of raw.pages) {
			if ("screenshot" in page) writeFileSync(join(out, page.screenshot.path), PNG);
		}
		writeFileSync(join(out, "raw-capture.json"), JSON.stringify(raw));
	};

const setup = (fake: Fake) => {
	const home = makeTempDir();
	const productDir = join(home, "product");
	mkdirSync(join(productDir, "web", "dist"), { recursive: true });
	const preview = createDockerPreview({
		factoryHome: home,
		exec: fake.exec,
		toolsSource: TOOLS_SOURCE,
		nodeImage: NODE_IMAGE,
		postgresImage: POSTGRES_IMAGE,
		playwrightImage: PLAYWRIGHT_IMAGE,
		user: { uid: 1000, gid: 1000 },
		homeDir: homedir(),
		newPreviewId: () => "pv0a1b2c",
		newSecret: () => "s3cret",
	});
	const outDir = join(home, "runs", RUN, "ui", COMMIT);
	const request = (
		policy: PreviewPolicy,
		routes: UiRoute[] = PUBLIC_ROOT,
		auth: UiAuth | null = null,
	) => ({
		runId: RUN,
		commitSha: COMMIT,
		productDir,
		policy,
		routes,
		auth,
		outDir,
	});
	return { preview, outDir, request, home, productDir };
};

describe("docker preview", () => {
	it("captures evidence, hashes it itself, binds the commit and records the script hash", async () => {
		const fake = makeFake({ writeCapture: writeGoodCapture(PUBLIC_ROOT) });
		const { preview, outDir, request } = setup(fake);
		const outcome = await preview.capture(request(WEB_POLICY));
		if (outcome.status !== "captured") throw new Error(outcome.reason);
		expect(UiEvidenceSchema.safeParse(outcome.evidence).success).toBe(true);
		expect(outcome.evidence.commitSha).toBe(COMMIT);
		const scriptHash = createHash("sha256")
			.update(readFileSync(join(TOOLS_SOURCE, "capture.mjs")))
			.digest("hex");
		expect(outcome.evidence.scriptSha256).toBe(scriptHash);
		const first = outcome.evidence.pages[0];
		if (first?.status !== "captured") throw new Error("expected a captured entry");
		expect(first.screenshot.sha256).toBe(createHash("sha256").update(PNG).digest("hex"));
		expect(first.screenshot.bytes).toBe(PNG.length);
		expect(existsSync(join(outDir, "ui-evidence.json"))).toBe(true);
		expect(outcome.evidencePath).toBe(join(outDir, "ui-evidence.json"));
		expect(outcome.teardownError).toBeNull();
		expect(fake.live()).toEqual({ containers: [], networks: [] });
	});

	it("labels, never publishes and passes routes and wait urls to the browser container", async () => {
		const fake = makeFake({ writeCapture: writeGoodCapture(TWO_PUBLIC) });
		const { preview, request } = setup(fake);
		await preview.capture(request(WEB_POLICY, TWO_PUBLIC));
		const created = fake.calls.filter(
			(c) => c[0] === "run" || (c[0] === "network" && c[1] === "create"),
		);
		expect(created.length).toBeGreaterThanOrEqual(4);
		for (const argv of created) {
			expect(argv).toContain("factory.managed=true");
			expect(argv).toContain(`factory.run=${RUN}`);
			expect(argv).not.toContain("-p");
			expect(argv.join(" ")).not.toContain("docker.sock");
		}
		const pw = fake.calls.find((c) => c.includes(PLAYWRIGHT_IMAGE)) ?? [];
		expect(pw).toContain('ROUTES=[{"path":"/","as":null},{"path":"/login","as":null}]');
		expect(pw.some((arg) => arg.startsWith("WAIT_URLS=") && arg.includes("-web:4173"))).toBe(true);
		expect(pw.some((arg) => arg.startsWith("BASE_URL=http://factory-"))).toBe(true);
	});

	it("serves the built product read-only and the tools read-only", async () => {
		const fake = makeFake({ writeCapture: writeGoodCapture(PUBLIC_ROOT) });
		const { preview, request, home } = setup(fake);
		await preview.capture(request(WEB_POLICY));
		const web = fake.calls.find((c) => argValue(c, "--name")?.endsWith("-web")) ?? [];
		const mounts = web.filter((_, i) => web[i - 1] === "--mount");
		expect(mounts[0]).toBe(
			`type=bind,source=${join(home, "product", "web/dist")},target=/site,readonly`,
		);
		expect(mounts[1]).toMatch(/preview-tools\/[0-9a-f]+,target=\/tool,readonly$/);
	});

	it("starts postgres, migrates, seeds and starts the api when the policy defines them", async () => {
		const fake = makeFake({ writeCapture: writeGoodCapture(PUBLIC_ROOT) });
		const { preview, request } = setup(fake);
		const outcome = await preview.capture(request(API_POLICY));
		expect(outcome.status).toBe("captured");
		const names = fake.calls.flatMap((c) => (c[0] === "run" ? [argValue(c, "--name") ?? ""] : []));
		const order = ["-step-", "-step-", "-step-", "-pg", "-step-", "-step-", "-api", "-web", "-pw"];
		let from = 0;
		for (const marker of order) {
			const found = names.findIndex((name, i) => i >= from && name.includes(marker));
			expect(found, `${marker} in ${names.join(",")}`).toBeGreaterThanOrEqual(from);
			from = found + 1;
		}
		const joined = fake.calls.map((c) => c.join(" ")).join("\n");
		expect(joined).not.toContain("postgresql://");
		expect(joined).not.toContain("s3cret");
		const pw = fake.calls.find((c) => c.includes(PLAYWRIGHT_IMAGE)) ?? [];
		expect(pw.some((arg) => arg.startsWith("WAIT_URLS=") && arg.includes(":3000/health"))).toBe(
			true,
		);
		expect(fake.live()).toEqual({ containers: [], networks: [] });
	});

	it("reports unavailable and tears down when a setup step fails", async () => {
		const fake = makeFake({
			failOn: (argv) =>
				argv.includes("build") && argv.includes("npm")
					? { status: 1, stdout: "", stderr: "build exploded" }
					: undefined,
		});
		const { preview, request } = setup(fake);
		const outcome = await preview.capture(request(WEB_POLICY));
		expect(outcome.status).toBe("unavailable");
		if (outcome.status === "unavailable") expect(outcome.reason).toContain("build");
		expect(fake.live()).toEqual({ containers: [], networks: [] });
	});

	it("reports unavailable when the app never answers (exit 3)", async () => {
		const fake = makeFake({
			failOn: (argv) =>
				argv.includes(PLAYWRIGHT_IMAGE)
					? { status: 3, stdout: "", stderr: "unreachable: http://x" }
					: undefined,
		});
		const { preview, request } = setup(fake);
		const outcome = await preview.capture(request(WEB_POLICY));
		expect(outcome.status).toBe("unavailable");
		if (outcome.status === "unavailable") expect(outcome.reason).toContain("did not answer");
		expect(fake.live()).toEqual({ containers: [], networks: [] });
	});

	it("reports unavailable when docker itself is missing, without throwing", async () => {
		const fake = makeFake({ dockerMissing: true });
		const { preview, request } = setup(fake);
		const outcome = await preview.capture(request(WEB_POLICY));
		expect(outcome.status).toBe("unavailable");
	});

	it("rejects evidence with an empty screenshot or a malformed capture", async () => {
		const empty = makeFake({
			writeCapture: (out) => {
				writeGoodCapture(PUBLIC_ROOT)(out);
				writeFileSync(join(out, shotOf(0, null, 390)), "");
			},
		});
		const emptyEnv = setup(empty);
		const first = await emptyEnv.preview.capture(emptyEnv.request(WEB_POLICY));
		expect(first.status).toBe("unavailable");
		const malformed = makeFake({
			writeCapture: (out) => writeFileSync(join(out, "raw-capture.json"), "{}"),
		});
		const env = setup(malformed);
		const second = await env.preview.capture(env.request(WEB_POLICY));
		expect(second.status).toBe("unavailable");
		const missing = makeFake();
		const env3 = setup(missing);
		const third = await env3.preview.capture(env3.request(WEB_POLICY));
		expect(third.status).toBe("unavailable");
		expect(missing.live()).toEqual({ containers: [], networks: [] });
	});

	it("surfaces a teardown failure without discarding captured evidence", async () => {
		const fake = makeFake({ writeCapture: writeGoodCapture(PUBLIC_ROOT), failTeardown: true });
		const { preview, request } = setup(fake);
		const outcome = await preview.capture(request(WEB_POLICY));
		expect(outcome.status).toBe("captured");
		if (outcome.status === "captured") expect(outcome.teardownError).toContain("network");
	});

	it("tears down only objects carrying its own preview label", async () => {
		const fake = makeFake({ writeCapture: writeGoodCapture(PUBLIC_ROOT) });
		const { preview, request } = setup(fake);
		await preview.capture(request(WEB_POLICY));
		const lists = fake.calls.filter((c) => c[0] === "ps" || (c[0] === "network" && c[1] === "ls"));
		expect(lists.length).toBeGreaterThan(0);
		for (const list of lists) expect(list).toContain("label=factory.preview=pv0a1b2c");
	});

	it("rejects a static dir that the build turned into a symlink to a host path", async () => {
		const outside = makeTempDir();
		writeFileSync(join(outside, "secret.txt"), "host secret");
		let productDir = "";
		const fake = makeFakeWithBuild(() => {
			rmSync(join(productDir, "web", "dist"), { recursive: true, force: true });
			symlinkSync(outside, join(productDir, "web", "dist"));
		});
		const env = setup(fake);
		productDir = env.productDir;
		const outcome = await env.preview.capture(env.request(WEB_POLICY));
		expect(outcome.status).toBe("unavailable");
		if (outcome.status === "unavailable") expect(outcome.reason).toContain("symbolic link");
		expect(fake.calls.some((c) => argValue(c, "--name")?.endsWith("-web"))).toBe(false);
		expect(fake.live()).toEqual({ containers: [], networks: [] });
	});

	it("rejects a static dir reached through a parent symlink that leaves the snapshot", async () => {
		const outside = makeTempDir();
		mkdirSync(join(outside, "dist"));
		let productDir = "";
		const fake = makeFakeWithBuild(() => {
			rmSync(join(productDir, "web"), { recursive: true, force: true });
			symlinkSync(outside, join(productDir, "web"));
		});
		const env = setup(fake);
		productDir = env.productDir;
		const outcome = await env.preview.capture(env.request(WEB_POLICY));
		expect(outcome.status).toBe("unavailable");
		if (outcome.status === "unavailable") expect(outcome.reason).toContain("outside the snapshot");
		expect(fake.calls.some((c) => argValue(c, "--name")?.endsWith("-web"))).toBe(false);
	});

	it("creates an egress network for install/build and an internal one for the runtime", async () => {
		const fake = makeFake({ writeCapture: writeGoodCapture(PUBLIC_ROOT) });
		const { preview, request } = setup(fake);
		await preview.capture(request(API_POLICY));
		const created = fake.calls.filter((c) => c[0] === "network" && c[1] === "create");
		expect(created.map((c) => c.includes("--internal"))).toEqual([false, true]);
		const netOf = (suffix: string): string | undefined => {
			const call = fake.calls.find((c) => argValue(c, "--name")?.endsWith(suffix));
			return call ? argValue(call, "--network") : undefined;
		};
		const egress = `factory-${RUN}-pv0a1b2c-net`;
		const internal = `factory-${RUN}-pv0a1b2c-int`;
		expect(netOf("-step-install")).toBe(egress);
		expect(netOf("-step-build")).toBe(egress);
		expect(netOf("-step-api-build")).toBe(egress);
		for (const suffix of ["-step-migrate", "-step-seed", "-pg", "-api", "-web", "-pw"]) {
			expect(netOf(suffix), suffix).toBe(internal);
		}
		expect(fake.live()).toEqual({ containers: [], networks: [] });
	});

	it("gives the api its web origin for cors and the web server its api upstream", async () => {
		const fake = makeFake({ writeCapture: writeGoodCapture(PUBLIC_ROOT) });
		const { preview, request } = setup(fake);
		await preview.capture(request(API_POLICY));
		const api = fake.calls.find((c) => argValue(c, "--name")?.endsWith("-api")) ?? [];
		expect(api).toContain(`CORS_ORIGINS=http://factory-${RUN}-pv0a1b2c-web:4173`);
		const web = fake.calls.find((c) => argValue(c, "--name")?.endsWith("-web")) ?? [];
		expect(web).toContain(`API_UPSTREAM=http://factory-${RUN}-pv0a1b2c-api:3000`);
		const webOnly = makeFake({ writeCapture: writeGoodCapture(PUBLIC_ROOT) });
		const env = setup(webOnly);
		await env.preview.capture(env.request(WEB_POLICY));
		const plainWeb = webOnly.calls.find((c) => argValue(c, "--name")?.endsWith("-web")) ?? [];
		expect(plainWeb.some((arg) => arg.startsWith("API_UPSTREAM="))).toBe(false);
	});

	it("refuses to run tools whose cached copy no longer matches the source", async () => {
		const fake = makeFake({ writeCapture: writeGoodCapture(PUBLIC_ROOT) });
		const { preview, request, home } = setup(fake);
		const first = await preview.capture(request(WEB_POLICY));
		expect(first.status).toBe("captured");
		const cacheRoot = join(home, "preview-tools");
		const key = readdirSync(cacheRoot)[0] ?? "";
		for (const file of ["capture.mjs", "static-server.mjs"]) {
			const cached = join(cacheRoot, key, file);
			const original = readFileSync(cached, "utf8");
			writeFileSync(cached, `${original}\n// tampered`);
			const second = await preview.capture(request(WEB_POLICY));
			expect(second.status, file).toBe("unavailable");
			if (second.status === "unavailable") expect(second.reason).toContain("tool cache");
			writeFileSync(cached, original);
		}
		expect((await preview.capture(request(WEB_POLICY))).status).toBe("captured");
	});

	it("passes roles and only the needed accounts to the browser and records per-entry auth", async () => {
		const routes: UiRoute[] = [
			{ path: "/", as: null },
			{ path: "/tickets", as: "admin" },
		];
		const auth: UiAuth = {
			loginPath: "/login",
			fields: { username: "Correo", password: "Contraseña" },
			submit: "Entrar",
			accounts: {
				admin: { username: "a@test.local", password: "test-only-pass-1" },
				cliente: { username: "c@test.local", password: "test-only-pass-2" },
			},
		};
		const fake = makeFake({ writeCapture: writeGoodCapture(routes) });
		const { preview, request } = setup(fake);
		const outcome = await preview.capture(request(WEB_POLICY, routes, auth));
		if (outcome.status !== "captured") throw new Error(outcome.reason);
		const pw = fake.calls.find((c) => c.includes(PLAYWRIGHT_IMAGE)) ?? [];
		const pwIndex = fake.calls.indexOf(pw);
		const authEnv = fake.envs[pwIndex]?.AUTH ?? "";
		expect(pw).toContain("AUTH");
		expect(pw.join(" ")).not.toContain("test-only-pass");
		expect(authEnv).toContain("a@test.local");
		expect(authEnv).not.toContain("c@test.local");
		expect(outcome.evidence.pages.map((p) => [p.route, p.as, p.status, p.authenticated])).toEqual([
			["/", null, "captured", false],
			["/", null, "captured", false],
			["/tickets", "admin", "captured", true],
			["/tickets", "admin", "captured", true],
		]);
		const noAuthPw = makeFake({ writeCapture: writeGoodCapture(PUBLIC_ROOT) });
		const env = setup(noAuthPw);
		await env.preview.capture(env.request(WEB_POLICY));
		const plain = noAuthPw.calls.find((c) => c.includes(PLAYWRIGHT_IMAGE)) ?? [];
		expect(plain).not.toContain("AUTH");
	});

	it("keeps a failed login as unavailable entries, never as captured", async () => {
		const routes: UiRoute[] = [{ path: "/tickets", as: "admin" }];
		const auth: UiAuth = {
			loginPath: "/login",
			fields: { username: "u", password: "p" },
			submit: "go",
			accounts: { admin: { username: "a", password: "wrong-pass-12345" } },
		};
		const fake = makeFake({ writeCapture: writeGoodCapture(routes, ["admin"]) });
		const { preview, request } = setup(fake);
		const outcome = await preview.capture(request(WEB_POLICY, routes, auth));
		if (outcome.status !== "captured") throw new Error(outcome.reason);
		expect(outcome.evidence.pages.map((p) => p.status)).toEqual(["unavailable", "unavailable"]);
		expect(JSON.stringify(outcome.evidence)).not.toContain("wrong-pass-12345");
	});

	it("rejects captures that miss a role entry, duplicate a shot or claim a public page is authenticated", async () => {
		const routes: UiRoute[] = [
			{ path: "/", as: null },
			{ path: "/t", as: "admin" },
		];
		const bad = [
			(out: string) => {
				writeGoodCapture(PUBLIC_ROOT)(out);
			},
			(out: string) => {
				writeGoodCapture(routes)(out);
				const file = join(out, "raw-capture.json");
				const raw = JSON.parse(readFileSync(file, "utf8"));
				raw.pages[2].screenshot.path = raw.pages[0].screenshot.path;
				writeFileSync(file, JSON.stringify(raw));
			},
			(out: string) => {
				writeGoodCapture(routes)(out);
				const file = join(out, "raw-capture.json");
				const raw = JSON.parse(readFileSync(file, "utf8"));
				raw.pages[0].authenticated = true;
				writeFileSync(file, JSON.stringify(raw));
			},
		];
		for (const writeCapture of bad) {
			const fake = makeFake({ writeCapture });
			const env = setup(fake);
			const auth: UiAuth = {
				loginPath: "/login",
				fields: { username: "u", password: "p" },
				submit: "go",
				accounts: { admin: { username: "a", password: "b" } },
			};
			const outcome = await env.preview.capture(env.request(WEB_POLICY, routes, auth));
			expect(outcome.status).toBe("unavailable");
		}
	});
});
