import { describe, expect, it } from "vitest";
import { parseCommitRef, parseGitName } from "../src/domain/git/names.js";

describe("parseGitName", () => {
	it.each(["main", "task-01", "a", "a".repeat(64), "0abc"])("accepts %s", (name) => {
		expect(parseGitName(name)).toEqual({ ok: true, value: name });
	});

	it.each([
		"",
		"-flag",
		"--upload-pack=x",
		"Upper",
		"a/b",
		"a..b",
		"a b",
		"a_b",
		"a".repeat(65),
		".hidden",
		"a;b",
		"a\nb",
		"-",
	])("rejects %j", (name) => {
		expect(parseGitName(name)).toMatchObject({ ok: false, error: { code: "invalid_git_name" } });
	});
});

describe("parseCommitRef", () => {
	it("accepts 40-char lowercase hex shas", () => {
		const sha = "a".repeat(40);
		expect(parseCommitRef(sha)).toEqual({ ok: true, value: sha });
	});

	it("accepts a valid branch name", () => {
		expect(parseCommitRef("main")).toEqual({ ok: true, value: "main" });
	});

	it.each(["HEAD~1", "--all", "abc..def", `${"a".repeat(41)}Z`, ""])("rejects %j", (ref) => {
		expect(parseCommitRef(ref)).toMatchObject({ ok: false });
	});
});
