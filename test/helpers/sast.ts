import type { CheckRunnerPort } from "../../src/modules/execution/ports.js";

export const SAST_SCRIPT = "factory/sast/scan.mjs";

type Finding = { rule: string; severity: "low" | "medium" | "high"; file: string; line: number };

export const sastOutput = (findings: Finding[]): string =>
	`FACTORY_SAST_RESULT ${JSON.stringify({
		version: 1,
		scanned: 3,
		findings: findings.map((f) => ({
			...f,
			fingerprint: Buffer.from(`${f.rule}${f.file}`).toString("hex").slice(0, 12),
		})),
	})}\n`;

export const CLEAN_SAST = sastOutput([]);
export const BASELINE_HIGH_SAST = sastOutput([
	{ rule: "eval-call", severity: "high", file: "src/old.js", line: 3 },
]);
export const NEW_HIGH_SAST = sastOutput([
	{ rule: "eval-call", severity: "high", file: "src/old.js", line: 3 },
	{ rule: "react-raw-html", severity: "high", file: "src/new.js", line: 9 },
]);
export const MEDIUM_SAST = sastOutput([
	{ rule: "weak-hash", severity: "medium", file: "src/h.js", line: 1 },
]);
export const BROKEN_SAST = "scanner crashed\n";

type SastScript = (index: number) => { stdout: string; exitCode: number };

export const sastRunner = (script: SastScript) => {
	const calls: string[] = [];
	const wrap = (runner: CheckRunnerPort): CheckRunnerPort => ({
		...runner,
		runCheck: async (input) => {
			if (input.argv[0] !== "node" || input.argv[1] !== "--input-type=module") {
				return runner.runCheck(input);
			}
			const { stdout, exitCode } = script(calls.length);
			calls.push(input.cwd);
			return runner.runCheck({
				...input,
				argv: [
					"node",
					"-e",
					`process.stdout.write(${JSON.stringify(stdout)});process.exit(${exitCode})`,
				],
			});
		},
	});
	return { wrap, calls };
};
