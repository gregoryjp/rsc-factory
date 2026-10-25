import type { CheckRunnerPort } from "../../src/modules/execution/ports.js";

export const AUDIT_ARGV = ["npm", "audit", "--omit=dev", "--json"];

export const LOCKFILE_WITH_DEP = JSON.stringify({
	lockfileVersion: 3,
	packages: { "": { name: "p" }, "node_modules/lodash": { version: "4.17.20" } },
});

export const LOCKFILE_EMPTY = JSON.stringify({
	lockfileVersion: 3,
	packages: { "": { name: "p" } },
});

type AuditScript = (index: number) => { stdout: string; exitCode: number };

export const auditRunner = (script: AuditScript) => {
	const calls: string[] = [];
	const wrap = (runner: CheckRunnerPort): CheckRunnerPort => ({
		...runner,
		runCheck: async (input) => {
			if (input.argv[0] !== "npm" || input.argv[1] !== "audit") return runner.runCheck(input);
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

type Severity = "info" | "low" | "moderate" | "high" | "critical";

type FixtureAdvisory = {
	pkg: string;
	severity: Severity;
	source: number;
	ghsa: string;
	fix?: boolean | { name: string; version: string; isSemVerMajor: boolean };
};

const ZERO = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };

const entry = (advisory: FixtureAdvisory) => ({
	name: advisory.pkg,
	severity: advisory.severity,
	isDirect: false,
	via: [
		{
			source: advisory.source,
			name: advisory.pkg,
			dependency: advisory.pkg,
			title: `Vulnerability in ${advisory.pkg}`,
			url: `https://github.com/advisories/${advisory.ghsa}`,
			severity: advisory.severity,
			cwe: ["CWE-1321"],
			cvss: { score: 7.5, vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H" },
			range: "<1.0.0",
		},
	],
	effects: [],
	range: "<1.0.0",
	nodes: [`node_modules/${advisory.pkg}`],
	fixAvailable: advisory.fix ?? true,
});

export const npmAuditJson = (advisories: FixtureAdvisory[]): string => {
	const counts = { ...ZERO };
	for (const advisory of advisories) {
		counts[advisory.severity] += 1;
		counts.total += 1;
	}
	return JSON.stringify({
		auditReportVersion: 2,
		vulnerabilities: Object.fromEntries(advisories.map((a) => [a.pkg, entry(a)])),
		metadata: {
			vulnerabilities: counts,
			dependencies: { prod: 10, dev: 0, optional: 0, peer: 0, peerOptional: 0, total: 10 },
		},
	});
};

export const CLEAN_AUDIT = npmAuditJson([]);

export const MODERATE_AUDIT = npmAuditJson([
	{ pkg: "semver", severity: "moderate", source: 1, ghsa: "GHSA-c2qf-rxjj-qqgw" },
]);

export const HIGH_AUDIT = npmAuditJson([
	{ pkg: "minimist", severity: "critical", source: 2, ghsa: "GHSA-xvch-5gv4-984h" },
	{
		pkg: "lodash",
		severity: "high",
		source: 3,
		ghsa: "GHSA-35jh-r3h4-6jhm",
		fix: { name: "lodash", version: "4.17.21", isSemVerMajor: false },
	},
]);

export const BASELINE_HIGH_AUDIT = npmAuditJson([
	{ pkg: "lodash", severity: "high", source: 3, ghsa: "GHSA-35jh-r3h4-6jhm" },
]);

export const NETWORK_ERROR_AUDIT = JSON.stringify({
	error: {
		code: "ENOTFOUND",
		summary:
			"request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org",
		detail: "",
	},
});

export const MALFORMED_AUDIT = "npm warn something\n{ this is not json";
