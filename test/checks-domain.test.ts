import { describe, expect, it } from "vitest";
import type { Check } from "../src/contracts/entities.js";
import { isCheckEvidenceValid, isCheckPassed } from "../src/domain/checks/evidence.js";

const sha = "a".repeat(40);
const check: Check = {
	id: "chk_1",
	runId: "run_1",
	taskId: null,
	argv: ["npm", "run", "check"],
	cwd: "product",
	exitCode: 0,
	durationMs: 10,
	commitSha: sha,
	logPath: "runs/run_1/checks/chk_1.log",
	logSha256: "b".repeat(64),
	isolated: true,
	createdAt: 1,
};

describe("isCheckEvidenceValid", () => {
	it("is valid only for the commit that was checked", () => {
		expect(isCheckEvidenceValid(check, sha)).toBe(true);
		expect(isCheckEvidenceValid(check, "c".repeat(40))).toBe(false);
	});

	it("rejects empty or malformed commits on either side", () => {
		expect(isCheckEvidenceValid(check, "")).toBe(false);
		expect(isCheckEvidenceValid({ ...check, commitSha: "" }, "")).toBe(false);
		expect(isCheckEvidenceValid({ ...check, commitSha: "abc" }, "abc")).toBe(false);
	});

	it("compares case-insensitively", () => {
		expect(isCheckEvidenceValid(check, sha.toUpperCase())).toBe(true);
	});
});

describe("isCheckPassed", () => {
	it("requires exit code 0", () => {
		expect(isCheckPassed(check)).toBe(true);
		expect(isCheckPassed({ ...check, exitCode: 1 })).toBe(false);
		expect(isCheckPassed({ ...check, exitCode: 124 })).toBe(false);
	});
});
