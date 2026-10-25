import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CODEX_IMAGE } from "../src/config/compatibility.js";
import { createCodexCliProvider } from "../src/infrastructure/providers/codex-cli-provider.js";
import type { ProviderRequest } from "../src/infrastructure/providers/provider-port.js";
import { ok } from "../src/shared/result.js";
import { makeTempDir } from "./helpers/env.js";

const FAKE_DOCKER = join(import.meta.dirname, "fixtures", "fake-docker.mjs");
const OkSchema = z.strictObject({ ok: z.boolean() });
const AUTH = '{"tokens":{"access_token":"SECRET-ACCESS-TOKEN"}}';

const request = (cwd: string, overrides: Partial<ProviderRequest> = {}): ProviderRequest => ({
	role: "reviewer-ui",
	provider: "codex",
	runId: "run_0f1e2d3c",
	prompt: "Review the page",
	systemPrompt: "You are a reviewer",
	jsonSchema: { type: "object", properties: { ok: { type: "boolean" } } },
	model: "gpt-6-astra",
	effort: "medium",
	maxBudgetUsd: 0,
	tools: [],
	cwd,
	timeoutMs: 5000,
	...overrides,
});

const setup = (
	scenario: string,
	options: { allowHostUnsafe?: boolean; withDocker?: boolean } = {},
) => {
	const root = makeTempDir();
	mkdirSync(join(root, "real-codex"));
	const authFile = join(root, "real-codex", "auth.json");
	writeFileSync(authFile, AUTH, { mode: 0o600 });
	const log = join(root, "docker.log");
	const stdinFile = join(root, "stdin.txt");
	const vendorDir = join(root, "vendor");
	mkdirSync(vendorDir);
	const provider = createCodexCliProvider({
		binaryPath: "/nonexistent/host-codex",
		authFile,
		workDir: join(root, "work"),
		env: { PATH: "/usr/bin", LANG: "C.UTF-8", SECRET_TOKEN: "do-not-leak" },
		...(options.allowHostUnsafe === true ? { allowHostUnsafe: true } : {}),
		...(options.withDocker === false
			? {}
			: {
					resolveDocker: async () =>
						ok({
							dockerBin: FAKE_DOCKER,
							baseEnv: {
								PATH: process.env.PATH ?? "",
								FAKE_DOCKER_SCENARIO: scenario,
								FAKE_DOCKER_LOG: log,
								FAKE_DOCKER_STDIN: stdinFile,
							},
							image: CODEX_IMAGE,
							vendorDir,
							user: { uid: 1000, gid: 1000 },
							hostHome: homedir(),
							forbiddenRoots: [join(homedir(), ".ssh"), join(homedir(), ".codex")],
						}),
				}),
	});
	const calls = (): string[][] =>
		existsSync(log)
			? readFileSync(log, "utf8")
					.split("\n")
					.filter((line) => line !== "")
					.map((line) => JSON.parse(line) as string[])
			: [];
	return { provider, calls, authFile, root, stdinFile, workDir: join(root, "work") };
};

const kinds = (calls: string[][]): string[] =>
	calls.map((argv) => (argv[0] === "network" ? `network ${argv[1]}` : (argv[0] ?? "")));

describe("real container event stream", () => {
	it("keeps the captured real_codex_docker_ok fixture parseable", () => {
		const types = readFileSync(
			join(import.meta.dirname, "fixtures", "codex", "real_codex_docker_ok.jsonl"),
			"utf8",
		)
			.trim()
			.split("\n")
			.map((line) => (JSON.parse(line) as { type: string }).type);
		expect(types).toEqual(["thread.started", "turn.started", "item.completed", "turn.completed"]);
	});
});

describe("CodexCliProvider in a container", () => {
	it("runs the call through docker and cleans up the container and network", async () => {
		const { provider, calls, stdinFile } = setup("ok");
		const result = await provider.invoke(request(makeTempDir()), OkSchema);
		expect(result).toMatchObject({ ok: true, value: { output: { ok: true } } });
		expect(kinds(calls())).toEqual(["network create", "run", "rm", "network rm"]);
		const run = calls()[1] ?? [];
		expect(run).toEqual(expect.arrayContaining(["--read-only", "--rm", "-i"]));
		expect(run[run.indexOf("--cap-drop") + 1]).toBe("ALL");
		const codexArgs = run.slice(run.indexOf("codex", run.indexOf(CODEX_IMAGE)) + 1);
		expect(codexArgs[0]).toBe("exec");
		expect(codexArgs[codexArgs.indexOf("-s") + 1]).toBe("danger-full-access");
		expect(codexArgs[codexArgs.indexOf("-C") + 1]).toBe("/workspace");
		expect(codexArgs[codexArgs.indexOf("--output-schema") + 1]).toBe("/input/schema.json");
		expect(codexArgs).toContain("--ignore-user-config");
		expect(codexArgs).toContain("--ignore-rules");
		expect(codexArgs).toContain("--disable");
		expect(readFileSync(stdinFile, "utf8")).toContain("Review the page");
		expect(run.join(" ")).not.toContain("SECRET");
		expect(run.join(" ")).not.toContain("do-not-leak");
	});

	it("labels every docker object with the run id", async () => {
		const { provider, calls } = setup("ok");
		await provider.invoke(request(makeTempDir()), OkSchema);
		const [network, run] = calls();
		for (const argv of [network ?? [], run ?? []]) {
			expect(argv).toEqual(
				expect.arrayContaining(["factory.managed=true", "factory.run=run_0f1e2d3c"]),
			);
		}
	});

	it("cleans up when the container exits non-zero", async () => {
		const { provider, calls } = setup("run_fail");
		const result = await provider.invoke(request(makeTempDir()), OkSchema);
		expect(result).toMatchObject({ ok: false, error: { kind: "provider_error" } });
		expect(kinds(calls())).toEqual(["network create", "run", "rm", "network rm"]);
	});

	it("cleans up and reports a timeout", async () => {
		const { provider, calls } = setup("hang");
		const result = await provider.invoke(request(makeTempDir(), { timeoutMs: 400 }), OkSchema);
		expect(result).toMatchObject({ ok: false, error: { kind: "timeout", retryable: true } });
		expect(kinds(calls())).toEqual(["network create", "run", "rm", "network rm"]);
	});

	it("writes a rotated auth.json back to the source and removes the call directory", async () => {
		const { provider, authFile, workDir } = setup("rotate_auth");
		await provider.invoke(request(makeTempDir()), OkSchema);
		expect(readFileSync(authFile, "utf8")).toBe('{"rotated":true}');
		expect(readdirSync(workDir)).toEqual([]);
	});

	it("mounts the workspace writable only for edit profiles", async () => {
		const edits = setup("ok");
		await edits.provider.invoke(
			request(makeTempDir(), { permissionMode: "acceptEdits" }),
			OkSchema,
		);
		const run = edits.calls()[1] ?? [];
		const workspace = run.find((arg) => arg.endsWith("target=/workspace")) ?? "";
		expect(workspace).not.toContain("readonly");
	});

	it("fails closed with codex_requires_docker when docker is unavailable", async () => {
		const { provider, calls } = setup("no_daemon");
		const result = await provider.invoke(request(makeTempDir()), OkSchema);
		expect(result).toMatchObject({
			ok: false,
			error: { kind: "provider_error", retryable: false },
		});
		expect(!result.ok && result.error.message).toContain("codex_requires_docker");
		expect(kinds(calls())).not.toContain("run");
	});

	it("fails closed when docker is not configured at all", async () => {
		const { provider } = setup("ok", { withDocker: false });
		const result = await provider.invoke(request(makeTempDir()), OkSchema);
		expect(!result.ok && result.error.message).toContain("codex_requires_docker");
	});

	it("falls back to the host only with the explicit unsafe opt-in", async () => {
		const { provider } = setup("no_daemon", { allowHostUnsafe: true });
		const result = await provider.invoke(request(makeTempDir()), OkSchema);
		expect(!result.ok && result.error.message).toContain("Could not run provider");
	});
});
