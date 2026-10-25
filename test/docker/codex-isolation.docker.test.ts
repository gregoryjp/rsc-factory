import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { CODEX_IMAGE } from "../../src/config/compatibility.js";
import {
	type CodexDockerIsolation,
	createCodexCliProvider,
} from "../../src/infrastructure/providers/codex-cli-provider.js";
import {
	buildCodexCleanupArgvs,
	buildCodexNetworkCreateArgv,
	buildCodexRunArgv,
	findCodexVendorDir,
} from "../../src/infrastructure/providers/codex-docker.js";
import type { ProviderRequest } from "../../src/infrastructure/providers/provider-port.js";
import { ok } from "../../src/shared/result.js";
import { dockerIdSalt } from "../helpers/id-salt.js";
import {
	baseEnv,
	containerUser,
	dockerAvailable,
	labeled,
	makeHomeTempDir,
	SKIP_REASON,
} from "./docker-helpers.js";

const RUN_ID = `run_codexiso_${dockerIdSalt()}`;
const vendor = findCodexVendorDir("codex", process.env.PATH);
const REAL_CALL = process.env.FACTORY_REAL_CODEX_DOCKER === "1";
const FORBIDDEN_ROOTS = [join(homedir(), ".ssh"), join(homedir(), ".codex")];

const isolation = (): CodexDockerIsolation => {
	if (!vendor.ok) throw new Error(vendor.error.message);
	return {
		dockerBin: "docker",
		baseEnv: baseEnv(),
		image: CODEX_IMAGE,
		vendorDir: vendor.value,
		user: containerUser,
		hostHome: homedir(),
		forbiddenRoots: FORBIDDEN_ROOTS,
	};
};

const sh = (args: readonly string[], input?: string) =>
	spawnSync("docker", [...args], { encoding: "utf8", ...(input === undefined ? {} : { input }) });

const probe = (callId: string, workspace: string, script: string) => {
	const home = makeHomeTempDir();
	const schema = join(home, "schema.json");
	writeFileSync(schema, "{}");
	const homeDir = join(home, "codex-home");
	mkdirSync(homeDir);
	writeFileSync(join(homeDir, "auth.json"), '{"copy":true}');
	const built = buildCodexRunArgv({
		runId: RUN_ID,
		callId,
		image: CODEX_IMAGE,
		vendorDir: isolation().vendorDir,
		homeDir,
		schemaFile: schema,
		workspace,
		writableWorkspace: false,
		user: containerUser,
		hostHome: homedir(),
		forbiddenRoots: FORBIDDEN_ROOTS,
		env: {},
		codexArgs: [],
	});
	if (!built.ok) throw new Error(built.error.message);
	const argv = [...built.value.slice(0, built.value.indexOf(CODEX_IMAGE) + 1), "-c", script];
	const created = sh(buildCodexNetworkCreateArgv(RUN_ID, callId));
	expect(created.status).toBe(0);
	const ran = sh(argv);
	for (const cleanup of buildCodexCleanupArgvs(RUN_ID, callId)) sh(cleanup);
	return ran;
};

afterEach(() => {
	if (!dockerAvailable) return;
	for (const name of labeled("ps", RUN_ID)) sh(["rm", "-f", name]);
	for (const name of labeled("network", RUN_ID)) sh(["network", "rm", name]);
});

describe.skipIf(!dockerAvailable || !vendor.ok)(
	`codex container isolation${dockerAvailable ? "" : ` (${SKIP_REASON})`}`,
	() => {
		it("hides the host home, ~/.ssh and the real auth.json, and keeps the rootfs read-only", () => {
			const workspace = makeHomeTempDir();
			writeFileSync(join(workspace, "snapshot.txt"), "reviewed");
			const script = [
				"echo ssh=$([ -e ~/.ssh ] && echo visible || echo absent)",
				`echo hostssh=$([ -e ${homedir()}/.ssh ] && echo visible || echo absent)`,
				`echo hostcodex=$([ -e ${homedir()}/.codex ] && echo visible || echo absent)`,
				`echo hosthome=$([ -e ${homedir()} ] && echo visible || echo absent)`,
				"echo auths=$(find / -name auth.json -not -path '/proc/*' -not -path '/sys/*' 2>/dev/null | sort | tr '\\n' ' ')",
				"echo sock=$(find / -name docker.sock -not -path '/proc/*' -not -path '/sys/*' 2>/dev/null | wc -l)",
				"touch /etc/probe 2>/dev/null && echo rootfs=writable || echo rootfs=readonly",
				"touch /opt/codex/probe 2>/dev/null && echo codex=writable || echo codex=readonly",
				"touch /workspace/probe 2>/dev/null && echo workspace=writable || echo workspace=readonly",
				"touch /tmp/probe 2>/dev/null && echo tmp=writable || echo tmp=readonly",
				"touch /codex-home/probe 2>/dev/null && echo home=writable || echo home=readonly",
				"echo user=$(id -u)",
				"grep -E '^CapEff' /proc/self/status",
				"grep -E '^NoNewPrivs' /proc/self/status",
				"cat /workspace/snapshot.txt",
			].join("; ");
			const ran = probe("probe1", workspace, script);
			expect(ran.status).toBe(0);
			const out = ran.stdout;
			expect(out).toContain("ssh=absent");
			expect(out).toContain("hostssh=absent");
			expect(out).toContain("hostcodex=absent");
			expect(out).toContain("hosthome=absent");
			expect(out).toMatch(/auths=\/codex-home\/auth\.json\s*\n/);
			expect(out).toContain("sock=0");
			expect(out).toContain("rootfs=readonly");
			expect(out).toContain("codex=readonly");
			expect(out).toContain("workspace=readonly");
			expect(out).toContain("tmp=writable");
			expect(out).toContain("home=writable");
			expect(out).toMatch(/CapEff:\s+0+\s/);
			expect(out).toMatch(/NoNewPrivs:\s+1/);
			expect(out).toContain("reviewed");
		});

		it("leaves no labeled containers or networks after a call", () => {
			probe("probe2", makeHomeTempDir(), "true");
			expect(labeled("ps", RUN_ID)).toEqual([]);
			expect(labeled("network", RUN_ID)).toEqual([]);
		});

		it("removes the objects even when the container exits non-zero", () => {
			const ran = probe("probe3", makeHomeTempDir(), "exit 7");
			expect(ran.status).toBe(7);
			expect(labeled("ps", RUN_ID)).toEqual([]);
			expect(labeled("network", RUN_ID)).toEqual([]);
		});
	},
);

const OkSchema = z.strictObject({ ok: z.boolean() });
const PngSchema = z.strictObject({ png_signature_ok: z.boolean(), size_bytes: z.number() });
const PNG_BYTES = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
	"base64",
);

const realRequest = (cwd: string, prompt: string): ProviderRequest => ({
	role: "reviewer-ui",
	provider: "codex",
	runId: RUN_ID,
	prompt,
	systemPrompt: "You are a minimal test reviewer. Answer only with the requested JSON.",
	jsonSchema: {},
	model: "gpt-6-astra",
	effort: "medium",
	maxBudgetUsd: 0,
	tools: [],
	cwd,
	timeoutMs: 240_000,
});

describe.skipIf(!dockerAvailable || !vendor.ok || !REAL_CALL)(
	"real codex call through the container (FACTORY_REAL_CODEX_DOCKER=1)",
	() => {
		const makeProvider = () => {
			const work = makeHomeTempDir();
			const authFile = join(work, "auth.json");
			copyFileSync(join(homedir(), ".codex", "auth.json"), authFile);
			return createCodexCliProvider({
				binaryPath: "codex",
				authFile,
				workDir: join(work, "calls"),
				env: baseEnv(),
				resolveDocker: async () => ok(isolation()),
			});
		};

		it("answers the trivial schema end to end and leaves nothing behind", async () => {
			const cwd = makeHomeTempDir();
			writeFileSync(join(cwd, "README.md"), "nothing to review");
			const schema = {
				type: "object",
				properties: { ok: { type: "boolean" } },
				required: ["ok"],
				additionalProperties: false,
			};
			const result = await makeProvider().invoke(
				{ ...realRequest(cwd, 'Reply with the JSON {"ok": true}.'), jsonSchema: schema },
				OkSchema,
			);
			expect(result).toMatchObject({ ok: true, value: { output: { ok: true } } });
			expect(labeled("ps", RUN_ID)).toEqual([]);
			expect(labeled("network", RUN_ID)).toEqual([]);
		});

		it("can read a PNG from the mounted evidence directory", async () => {
			const cwd = makeHomeTempDir();
			mkdirSync(join(cwd, "ui-evidence"));
			writeFileSync(join(cwd, "ui-evidence", "shot.png"), PNG_BYTES);
			expect(existsSync(join(cwd, "ui-evidence", "shot.png"))).toBe(true);
			const schema = {
				type: "object",
				properties: { png_signature_ok: { type: "boolean" }, size_bytes: { type: "number" } },
				required: ["png_signature_ok", "size_bytes"],
				additionalProperties: false,
			};
			const result = await makeProvider().invoke(
				{
					...realRequest(
						cwd,
						"Use one shell command to inspect ui-evidence/shot.png. Report whether its first 8 bytes are the PNG signature and its size in bytes.",
					),
					jsonSchema: schema,
				},
				PngSchema,
			);
			expect(result).toMatchObject({
				ok: true,
				value: { output: { png_signature_ok: true, size_bytes: PNG_BYTES.length } },
			});
		});
	},
);
