import { describe, expect, it } from "vitest";
import { scanFiles } from "../src/domain/security/secret-scan.js";

const awsKey = `AKIA${"ABCDEFGHIJKLMNOP"}`;
const assigned = `const apiKey = "${"x9Qr7TnLw2Zp4Vb8"}";`;
const pemHeader = `-----BEGIN ${"RSA PRIVATE"} KEY-----`;

describe("scanFiles", () => {
	it("flags .env files but allows .env.example and *.example", () => {
		const findings = scanFiles([
			{ path: ".env", content: "A=1" },
			{ path: "api/.env.production", content: "A=1" },
			{ path: ".env.example", content: "A=1" },
			{ path: "api/.env.test.example", content: "A=1" },
			{ path: "config.example", content: "A=1" },
		]);
		expect(findings.map((f) => [f.file, f.rule])).toEqual([
			[".env", "env_file"],
			["api/.env.production", "env_file"],
		]);
	});

	it("flags private key headers with file and line", () => {
		const findings = scanFiles([{ path: "keys/id.pem", content: `a\nb\n${pemHeader}\nc` }]);
		expect(findings).toEqual([{ file: "keys/id.pem", line: 3, rule: "private_key" }]);
	});

	it("flags AWS access key ids", () => {
		const findings = scanFiles([{ path: "src/a.ts", content: `x\nconst k = "${awsKey}";` }]);
		expect(findings).toEqual([{ file: "src/a.ts", line: 2, rule: "aws_access_key_id" }]);
	});

	it("flags long quoted secret-like assignments in source", () => {
		const findings = scanFiles([{ path: "src/config.ts", content: assigned }]);
		expect(findings).toEqual([{ file: "src/config.ts", line: 1, rule: "secret_assignment" }]);
	});

	it.each([['password: "short"'], ["const token = process.env.TOKEN;"], ['const secret = ""']])(
		"ignores harmless assignment %s",
		(content) => {
			expect(scanFiles([{ path: "src/a.ts", content }])).toEqual([]);
		},
	);

	it.each([
		"api/test/db.test.ts",
		"src/modules/x/__tests__/a.ts",
		"test/fixtures/data.ts",
		"docs/examples/auth.md",
		"src/a.test.ts",
		"src/a.spec.ts",
		"api/.env.example",
	])("does not apply the generic assignment rule to %s", (path) => {
		expect(scanFiles([{ path, content: assigned }])).toEqual([]);
	});

	it("still flags private keys and AWS ids inside test paths", () => {
		const findings = scanFiles([{ path: "test/a.ts", content: `${pemHeader}\n${awsKey}` }]);
		expect(findings.map((f) => f.rule)).toEqual(["private_key", "aws_access_key_id"]);
	});

	it("never includes the secret value in the findings", () => {
		const findings = scanFiles([
			{ path: "src/a.ts", content: `${assigned}\n${awsKey}\n${pemHeader}` },
			{ path: ".env", content: "TOKEN=abcdefghijklmnop" },
		]);
		const serialized = JSON.stringify(findings);
		expect(serialized).not.toContain("x9Qr7TnLw2Zp4Vb8");
		expect(serialized).not.toContain(awsKey);
		expect(serialized).not.toContain("abcdefghijklmnop");
		expect(serialized).not.toContain("PRIVATE");
		expect(findings).toHaveLength(4);
	});

	it("reports one finding per rule per line", () => {
		const content = `${assigned} ${assigned}`;
		expect(scanFiles([{ path: "src/a.ts", content }])).toHaveLength(1);
	});

	it("flags .envrc files anywhere", () => {
		const findings = scanFiles([
			{ path: ".envrc", content: "export A=1" },
			{ path: "api/.envrc", content: "export A=1" },
		]);
		expect(findings.map((f) => f.rule)).toEqual(["env_file", "env_file"]);
	});

	it("applies the high-confidence rules to fixtures and examples too", () => {
		const findings = scanFiles([
			{ path: "test/fixtures/key.ts", content: pemHeader },
			{ path: "docs/examples/aws.md", content: awsKey },
			{ path: "test/fixtures/.env", content: "A=1" },
		]);
		expect(findings.map((f) => f.rule)).toEqual(["private_key", "aws_access_key_id", "env_file"]);
	});
});
