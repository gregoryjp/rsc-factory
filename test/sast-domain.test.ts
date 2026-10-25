import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCheckPolicy } from "../src/domain/checks/policy.js";
import { evaluateSast } from "../src/domain/sast/evaluate.js";
import { buildSastArgv, parseSastOutput } from "../src/domain/sast/parse.js";
import { summarizeSast } from "../src/domain/sast/summary.js";
import { makeTempDir, REPO_ROOT } from "./helpers/env.js";

const scan = (files: Record<string, string>) => {
	const dir = makeTempDir();
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
	const script = join(REPO_ROOT, "factory/sast/scan.mjs");
	const run = spawnSync("node", [script], { cwd: dir, encoding: "utf8" });
	const parsed = parseSastOutput(run.stdout);
	if (parsed.status !== "parsed") throw new Error(parsed.reason);
	return parsed.findings;
};

describe("factory/sast/scan.mjs", () => {
	it("flags eval, innerHTML, hardcoded secrets and disabled TLS verification", () => {
		const findings = scan({
			"src/a.ts": [
				"const x = eval(input);",
				"el.innerHTML = value;",
				'const apiKey = "abcdef1234567890abcdef1234";',
				"const agent = { rejectUnauthorized: false };",
			].join("\n"),
		});
		expect(findings.map((f) => [f.rule, f.severity, f.line])).toEqual([
			["eval-call", "high", 1],
			["dom-inner-html", "high", 2],
			["hardcoded-secret", "high", 3],
			["tls-verification-disabled", "high", 4],
		]);
	});

	it("ignores safe code, test files, node_modules and build output", () => {
		const findings = scan({
			"src/ok.ts": "const a = JSON.parse(text);\nconst c = createHash('sha256');",
			"src/a.test.ts": "eval(x)",
			"test/b.ts": "eval(x)",
			"node_modules/p/i.js": "eval(x)",
			"dist/o.js": "eval(x)",
		});
		expect(findings).toEqual([]);
	});

	it("keeps the fingerprint stable when the line moves", () => {
		const first = scan({ "a.js": "eval(x)" });
		const moved = scan({ "a.js": "\n\n  eval(x)" });
		expect(moved[0]?.line).toBe(3);
		expect(moved[0]?.fingerprint).toBe(first[0]?.fingerprint);
	});

	it("applies the html target rule only in html files", () => {
		const findings = scan({
			"index.html": '<a href="https://x.dev" target="_blank">x</a>',
			"a.js": "const s = '<a target=\"_blank\">';",
		});
		expect(findings.map((f) => [f.rule, f.file])).toEqual([["blank-target-no-rel", "index.html"]]);
	});
});

describe("parseSastOutput", () => {
	it("is unavailable without the marker line or with invalid json", () => {
		expect(parseSastOutput("").status).toBe("unavailable");
		expect(parseSastOutput("FACTORY_SAST_RESULT {nope").status).toBe("unavailable");
		expect(parseSastOutput('FACTORY_SAST_RESULT {"version":9}').status).toBe("unavailable");
	});

	it("tolerates noise around the marker line", () => {
		const line = `FACTORY_SAST_RESULT ${JSON.stringify({ version: 1, scanned: 2, findings: [] })}`;
		expect(parseSastOutput(`warn\n${line}\n`)).toEqual({
			status: "parsed",
			scanned: 2,
			findings: [],
		});
	});

	it("builds an argv that runs the script source with node", () => {
		expect(buildSastArgv("console.log(1)")).toEqual([
			"node",
			"--input-type=module",
			"-e",
			"console.log(1)",
		]);
	});
});

const finding = (rule: string, severity: "low" | "medium" | "high", fingerprint: string) => ({
	rule,
	severity,
	file: "a.ts",
	line: 1,
	fingerprint,
});

describe("evaluateSast", () => {
	const base = [finding("eval-call", "high", "aaa")];

	it("passes known findings as accepted baseline and counts severities", () => {
		const verdict = evaluateSast(
			{ status: "parsed", scanned: 1, findings: [...base, finding("weak-hash", "medium", "bbb")] },
			base,
		);
		expect(verdict).toMatchObject({
			status: "pass",
			counts: { low: 0, medium: 1, high: 1 },
			newSevere: [],
		});
		if (verdict.status === "unavailable") throw new Error("unexpected");
		expect(verdict.acceptedBaseline).toHaveLength(1);
		expect(verdict.newOther).toHaveLength(1);
	});

	it("blocks a new high finding", () => {
		const verdict = evaluateSast(
			{
				status: "parsed",
				scanned: 1,
				findings: [...base, finding("react-raw-html", "high", "ccc")],
			},
			base,
		);
		expect(verdict.status).toBe("new_finding");
	});

	it("never passes when unavailable or without a baseline", () => {
		expect(evaluateSast({ status: "unavailable", reason: "x" }, base).status).toBe("unavailable");
		expect(evaluateSast({ status: "parsed", scanned: 0, findings: [] }, null).status).toBe(
			"unavailable",
		);
	});
});

describe("summarizeSast and policy", () => {
	it("blocks on the last non-baseline entry", () => {
		const summary = summarizeSast([
			{ type: "sast.recorded", payload: { phase: "baseline", status: "baseline" } },
			{
				type: "sast.recorded",
				payload: {
					phase: "task",
					status: "new_finding",
					newSevere: [{ rule: "eval-call", file: "a.ts", severity: "high" }],
				},
			},
		]);
		expect(summary.blockingNew).toBe(1);
		expect(summary.unavailable).toBe(false);
	});

	it("accepts a sast script path in the check policy and rejects traversal", () => {
		const entry = (sast: string) =>
			JSON.stringify({ t: { install: [], test: ["a"], check: ["a"], sast } });
		expect(parseCheckPolicy(entry("factory/sast/scan.mjs")).ok).toBe(true);
		expect(parseCheckPolicy(entry("../x.mjs")).ok).toBe(false);
	});
});
