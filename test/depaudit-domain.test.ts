import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCheckPolicy } from "../src/domain/checks/policy.js";
import { evaluateAudit } from "../src/domain/depaudit/evaluate.js";
import { hasLockedDependencies } from "../src/domain/depaudit/lockfile.js";
import { parseNpmAudit } from "../src/domain/depaudit/parse.js";
import { CHECK_POLICY_PATH } from "../src/modules/execution/build-policy.js";
import { REPO_ROOT } from "./helpers/env.js";
import {
	BASELINE_HIGH_AUDIT,
	CLEAN_AUDIT,
	HIGH_AUDIT,
	MALFORMED_AUDIT,
	MODERATE_AUDIT,
	NETWORK_ERROR_AUDIT,
} from "./helpers/npm-audit.js";

const advisories = (text: string) => {
	const parsed = parseNpmAudit(text);
	if (parsed.status !== "parsed") throw new Error(`unexpected ${parsed.status}`);
	return parsed.advisories;
};

describe("parseNpmAudit", () => {
	it("parses a clean report", () => {
		expect(parseNpmAudit(CLEAN_AUDIT)).toEqual({ status: "parsed", advisories: [] });
	});

	it("extracts ghsa id, package, severity and fix availability from npm 10 output", () => {
		expect(advisories(HIGH_AUDIT)).toEqual([
			{ id: "GHSA-xvch-5gv4-984h", package: "minimist", severity: "critical", fixAvailable: true },
			{ id: "GHSA-35jh-r3h4-6jhm", package: "lodash", severity: "high", fixAvailable: true },
		]);
	});

	it("treats fixAvailable false as no fix and tolerates npm warn noise around the json", () => {
		const raw = JSON.stringify({
			auditReportVersion: 2,
			vulnerabilities: {
				foo: {
					name: "foo",
					severity: "high",
					via: [{ source: 9, name: "foo", url: "https://example.test/x", severity: "high" }],
					fixAvailable: false,
				},
			},
		});
		const parsed = parseNpmAudit(`npm warn config ignored\n${raw}\nnpm warn tail\n`);
		expect(parsed).toEqual({
			status: "parsed",
			advisories: [{ id: "npm:9", package: "foo", severity: "high", fixAvailable: false }],
		});
	});

	it("ignores transitive entries that only point at other packages", () => {
		const raw = JSON.stringify({
			vulnerabilities: {
				a: { name: "a", severity: "high", via: ["b"], fixAvailable: true },
				b: {
					name: "b",
					severity: "high",
					via: [
						{
							source: 5,
							name: "b",
							url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
							severity: "high",
						},
					],
					fixAvailable: true,
				},
			},
		});
		expect(advisories(raw).map((a) => a.package)).toEqual(["b"]);
	});

	it("reports the registry error as unavailable with its reason", () => {
		const parsed = parseNpmAudit(NETWORK_ERROR_AUDIT);
		expect(parsed.status).toBe("unavailable");
		if (parsed.status === "unavailable") expect(parsed.reason).toContain("ENOTFOUND");
	});

	it.each([
		["malformed", MALFORMED_AUDIT],
		["empty", ""],
		["json without vulnerabilities", '{"hello":1}'],
	])("reports %s output as unavailable", (_name, text) => {
		expect(parseNpmAudit(text).status).toBe("unavailable");
	});
});

describe("evaluateAudit", () => {
	const baseline = advisories(BASELINE_HIGH_AUDIT);

	it("passes a clean report", () => {
		expect(evaluateAudit(parseNpmAudit(CLEAN_AUDIT), baseline)).toMatchObject({
			status: "pass",
			newSevere: [],
			acceptedBaseline: [],
		});
	});

	it("passes moderate-only advisories and keeps them as non-blocking", () => {
		const verdict = evaluateAudit(parseNpmAudit(MODERATE_AUDIT), []);
		expect(verdict).toMatchObject({ status: "pass", newSevere: [] });
		if (verdict.status === "pass") {
			expect(verdict.counts.moderate).toBe(1);
			expect(verdict.newOther).toHaveLength(1);
		}
	});

	it("blocks on a new high or critical advisory", () => {
		const verdict = evaluateAudit(parseNpmAudit(HIGH_AUDIT), []);
		expect(verdict.status).toBe("new_vulnerability");
		if (verdict.status === "new_vulnerability") {
			expect(verdict.newSevere.map((a) => a.package)).toEqual(["minimist", "lodash"]);
		}
	});

	it("lists baseline advisories as accepted_baseline and blocks only on the new one", () => {
		const verdict = evaluateAudit(parseNpmAudit(HIGH_AUDIT), baseline);
		expect(verdict.status).toBe("new_vulnerability");
		if (verdict.status === "new_vulnerability") {
			expect(verdict.newSevere.map((a) => a.package)).toEqual(["minimist"]);
			expect(verdict.acceptedBaseline.map((a) => a.package)).toEqual(["lodash"]);
		}
	});

	it("passes when only the baseline high advisory remains, still listing it", () => {
		const verdict = evaluateAudit(parseNpmAudit(BASELINE_HIGH_AUDIT), baseline);
		expect(verdict.status).toBe("pass");
		if (verdict.status === "pass") expect(verdict.acceptedBaseline).toHaveLength(1);
	});

	it("is unavailable, never a pass, when the registry could not be reached", () => {
		expect(evaluateAudit(parseNpmAudit(NETWORK_ERROR_AUDIT), baseline)).toMatchObject({
			status: "unavailable",
		});
		expect(evaluateAudit(parseNpmAudit(MALFORMED_AUDIT), baseline).status).toBe("unavailable");
	});

	it("is unavailable when no baseline was recorded", () => {
		const verdict = evaluateAudit(parseNpmAudit(CLEAN_AUDIT), null);
		expect(verdict).toMatchObject({ status: "unavailable" });
		if (verdict.status === "unavailable") expect(verdict.reason).toContain("baseline");
	});
});

describe("audit check policy", () => {
	const policy = parseCheckPolicy(readFileSync(join(REPO_ROOT, CHECK_POLICY_PATH), "utf8"));

	it.each(["api", "apiweb", "landing", "mobile"])("%s declares the npm audit argv", (id) => {
		if (!policy.ok) throw new Error(policy.error.message);
		expect(policy.value[id]?.audit).toEqual(["npm", "audit", "--omit=dev", "--json"]);
	});

	it("keeps the field optional and rejects an empty argv", () => {
		const base = { install: [], test: ["t"], check: ["c"] };
		expect(parseCheckPolicy(JSON.stringify({ x: base })).ok).toBe(true);
		expect(parseCheckPolicy(JSON.stringify({ x: { ...base, audit: [] } })).ok).toBe(false);
	});
});

describe("hasLockedDependencies", () => {
	it("is false for a missing, unparsable or dependency-free lockfile", () => {
		expect(hasLockedDependencies(null)).toBe(false);
		expect(hasLockedDependencies("not json")).toBe(false);
		expect(hasLockedDependencies(JSON.stringify({ packages: { "": { name: "x" } } }))).toBe(false);
		expect(
			hasLockedDependencies(JSON.stringify({ packages: { "": {}, web: { link: true } } })),
		).toBe(false);
	});

	it("is true when a dependency is locked", () => {
		expect(
			hasLockedDependencies(
				JSON.stringify({ packages: { "": {}, "node_modules/lodash": { version: "4.17.21" } } }),
			),
		).toBe(true);
	});
});
