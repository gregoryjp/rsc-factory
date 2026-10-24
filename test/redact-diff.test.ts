import { describe, expect, it } from "vitest";
import { redactDiff } from "../src/domain/security/redact-diff.js";

const diffOf = (path: string, added: string[]): string =>
	[
		`diff --git a/${path} b/${path}`,
		"new file mode 100644",
		"--- /dev/null",
		`+++ b/${path}`,
		`@@ -0,0 +1,${added.length} @@`,
		...added.map((line) => `+${line}`),
		"",
	].join("\n");

describe("redactDiff", () => {
	it("redacts the value of a secret assignment on an added line and reports the rule", () => {
		const out = redactDiff(diffOf("src/cfg.ts", ['const apiKey = "sk_live_abcdefghijklmnop";']));
		expect(out.text).not.toContain("sk_live_abcdefghijklmnop");
		expect(out.text).toContain("[REDACTED:secret_assignment]");
		expect(out.text).toContain("src/cfg.ts");
		expect(out.rules).toEqual(["secret_assignment"]);
	});

	it("redacts AWS access key ids", () => {
		const out = redactDiff(diffOf("src/a.ts", ["const id = 'AKIAABCDEFGHIJKLMNOP';"]));
		expect(out.text).not.toContain("AKIAABCDEFGHIJKLMNOP");
		expect(out.rules).toEqual(["aws_access_key_id"]);
	});

	it("redacts a whole private key block", () => {
		const out = redactDiff(
			diffOf("k.txt", [
				"-----BEGIN RSA PRIVATE KEY-----",
				"MIIEowIBAAKCAQEAsecretbody",
				"-----END RSA PRIVATE KEY-----",
				"after",
			]),
		);
		expect(out.text).not.toContain("secretbody");
		expect(out.text).not.toContain("BEGIN RSA PRIVATE KEY");
		expect(out.text).toContain("+after");
		expect(out.rules).toEqual(["private_key"]);
	});

	it("redacts every added line of an env file", () => {
		const out = redactDiff(diffOf(".env", ["DB_URL=postgres://user:pw@h/db", "X=1"]));
		expect(out.text).not.toContain("postgres://");
		expect(out.rules).toEqual(["env_file"]);
	});

	it("leaves removed and context lines and clean diffs untouched", () => {
		const clean = diffOf("src/a.ts", ["export const a = 1;"]);
		expect(redactDiff(clean)).toEqual({ text: clean, rules: [] });
		const removed =
			"--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-const token = 'abcdefghijklmnopqrst';\n+ok\n";
		expect(redactDiff(removed).rules).toEqual([]);
	});
});
