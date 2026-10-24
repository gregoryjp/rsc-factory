import { describe, expect, it } from "vitest";
import {
	RefuterOutputSchema,
	type ReviewerOutput,
	ReviewerOutputSchema,
} from "../src/contracts/review.js";
import { dedupFindings, titleSimilarity } from "../src/domain/review/dedup.js";
import { evaluateGate, type GateInput } from "../src/domain/review/gate.js";
import {
	applyRefutation,
	type FindingState,
	type ReviewRecord,
	severeFindings,
} from "../src/domain/review/types.js";
import {
	validateApproverOutput,
	validateRefuterOutput,
	validateReviewerOutput,
} from "../src/domain/review/validate.js";

const finding = (over: Record<string, unknown> = {}) => ({
	id: "F1",
	severity: "medium" as const,
	confidence: "high" as const,
	title: "Missing input validation on login",
	file: "src/login.js",
	lineStart: 10,
	lineEnd: 12,
	evidence: "req.body used directly",
	impact: "bad input reaches the db",
	recommendation: "validate with a schema",
	...over,
});

const output = (over: Partial<ReviewerOutput> = {}): ReviewerOutput => ({
	area: "code",
	verdict: "pass",
	findings: [],
	requiresReviewAck: [],
	...over,
});

const check = (value: ReviewerOutput, paths: string[] = [], area: "code" | "security" = "code") =>
	validateReviewerOutput(value, { area, requiresReviewPaths: paths });

describe("reviewer output contract", () => {
	it("accepts a clean pass and a findings verdict", () => {
		expect(check(output()).ok).toBe(true);
		expect(check(output({ verdict: "findings", findings: [finding()] })).ok).toBe(true);
	});

	it("rejects unknown keys and a missing requiresReviewAck at schema level", () => {
		expect(ReviewerOutputSchema.safeParse({ ...output(), extra: 1 }).success).toBe(false);
		const { requiresReviewAck: _omitted, ...rest } = output();
		expect(ReviewerOutputSchema.safeParse(rest).success).toBe(false);
		expect(
			ReviewerOutputSchema.safeParse(output({ findings: [finding({ evidence: "" })] })).success,
		).toBe(false);
	});

	it.each([
		["high without file", finding({ severity: "high", file: undefined })],
		["critical without file", finding({ severity: "critical", file: undefined })],
		["high with blank evidence", finding({ severity: "high", evidence: "   " })],
	])("rejects %s as malformed", (_name, bad) => {
		const result = check(output({ verdict: "findings", findings: [bad as never] }));
		expect(result.ok).toBe(false);
	});

	it("allows medium findings without a file", () => {
		expect(
			check(output({ verdict: "findings", findings: [finding({ file: undefined })] })).ok,
		).toBe(true);
	});

	it.each([
		["pass with findings", output({ verdict: "pass", findings: [finding()] })],
		["findings verdict with no findings", output({ verdict: "findings" })],
		["not_applicable without reason", output({ verdict: "not_applicable" })],
		["blocked with blank reason", output({ verdict: "blocked", reason: "  " })],
		[
			"blocked carrying findings",
			output({ verdict: "blocked", reason: "x", findings: [finding()] }),
		],
		["duplicate ids", output({ verdict: "findings", findings: [finding(), finding()] })],
		[
			"lineEnd before lineStart",
			output({ verdict: "findings", findings: [finding({ lineStart: 9, lineEnd: 3 })] }),
		],
	])("rejects %s", (_name, bad) => {
		expect(check(bad).ok).toBe(false);
	});

	it("rejects a reviewer answering for another area", () => {
		expect(check(output({ area: "security" }), [], "code").ok).toBe(false);
	});

	it("requires an ack for every requiresReview path from the code reviewer", () => {
		const missing = check(output(), ["biome.json", "tsconfig.json"]);
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.error.errors.join(" ")).toContain("tsconfig.json");
		const acked = check(
			output({
				requiresReviewAck: [
					{ path: "biome.json", decision: "ok", note: "formatting only" },
					{ path: "tsconfig.json", decision: "ok", note: "same strictness" },
				],
			}),
			["biome.json", "tsconfig.json"],
		);
		expect(acked.ok).toBe(true);
	});

	it("rejects an ack with decision finding when no finding references that path", () => {
		const result = check(
			output({ requiresReviewAck: [{ path: "biome.json", decision: "finding", note: "bad" }] }),
			["biome.json"],
		);
		expect(result.ok).toBe(false);
	});

	it("does not demand acks from a blocked reviewer", () => {
		expect(check(output({ verdict: "blocked", reason: "cannot inspect" }), ["biome.json"]).ok).toBe(
			true,
		);
	});
});

describe("refuter and approver contracts", () => {
	it("requires one outcome per sent finding and no unknown ids", () => {
		const sent = ["F1", "F2"];
		const ok1 = validateRefuterOutput(
			{
				outcomes: [
					{ id: "F1", outcome: "refuted", evidence: "guarded in caller" },
					{ id: "F2", outcome: "confirmed", evidence: "reachable" },
				],
			},
			sent,
		);
		expect(ok1.ok).toBe(true);
		const missing = validateRefuterOutput(
			{ outcomes: [{ id: "F1", outcome: "refuted", evidence: "x" }] },
			sent,
		);
		expect(missing.ok).toBe(false);
		const unknown = validateRefuterOutput(
			{
				outcomes: [
					{ id: "F1", outcome: "refuted", evidence: "x" },
					{ id: "F2", outcome: "refuted", evidence: "x" },
					{ id: "F9", outcome: "refuted", evidence: "x" },
				],
			},
			sent,
		);
		expect(unknown.ok).toBe(false);
		expect(
			RefuterOutputSchema.safeParse({ outcomes: [{ id: "F1", outcome: "maybe", evidence: "x" }] })
				.success,
		).toBe(false);
	});

	it("rejects approver repair tasks naming unknown findings", () => {
		const good = {
			recommendation: "repair" as const,
			repairTasks: [{ findingIds: ["F1"], instruction: "fix" }],
			notes: "",
		};
		expect(validateApproverOutput(good, ["F1"]).ok).toBe(true);
		expect(
			validateApproverOutput(
				{ ...good, repairTasks: [{ findingIds: ["F7"], instruction: "fix" }] },
				["F1"],
			).ok,
		).toBe(false);
	});
});

const input = (area: "security" | "code", over: Record<string, unknown> = {}) => ({
	area,
	finding: finding(over),
});

describe("dedup", () => {
	it("computes normalized token overlap", () => {
		expect(titleSimilarity("SQL injection in login", "sql injection login")).toBeGreaterThanOrEqual(
			0.5,
		);
		expect(titleSimilarity("Missing CSRF token", "Unused import")).toBeLessThan(0.5);
	});

	it("merges the same finding from two reviewers keeping both sources and evidence", () => {
		const merged = dedupFindings([
			input("security", { id: "S1", lineStart: 10, lineEnd: 12, evidence: "ev-security" }),
			input("code", {
				id: "C1",
				lineStart: 14,
				lineEnd: 15,
				title: "Missing validation on login input",
				evidence: "ev-code",
			}),
		]);
		expect(merged).toHaveLength(1);
		expect(merged[0]?.sources.map((s) => [s.area, s.id, s.evidence])).toEqual([
			["security", "S1", "ev-security"],
			["code", "C1", "ev-code"],
		]);
		expect(merged[0]?.lineStart).toBe(10);
		expect(merged[0]?.lineEnd).toBe(15);
	});

	it("does not merge distant lines, other files or dissimilar titles", () => {
		expect(
			dedupFindings([
				input("security", { id: "A" }),
				input("code", { id: "B", lineStart: 40, lineEnd: 41 }),
			]),
		).toHaveLength(2);
		expect(
			dedupFindings([
				input("security", { id: "A" }),
				input("code", { id: "B", file: "src/other.js" }),
			]),
		).toHaveLength(2);
		expect(
			dedupFindings([
				input("security", { id: "A" }),
				input("code", { id: "B", title: "Rename variable for clarity" }),
			]),
		).toHaveLength(2);
	});

	it("merges within the ±3 window and keeps the higher severity within a class", () => {
		const merged = dedupFindings([
			input("security", { id: "A", severity: "high", lineStart: 10, lineEnd: 10 }),
			input("code", { id: "B", severity: "critical", lineStart: 13, lineEnd: 13 }),
		]);
		expect(merged).toHaveLength(1);
		expect(merged[0]?.severity).toBe("critical");
	});

	it("keeps same-location different-class findings separate and links them with conflictsWith", () => {
		const merged = dedupFindings([
			input("security", { id: "A", severity: "high", evidence: "e1" }),
			input("code", { id: "B", severity: "low", evidence: "e2" }),
		]);
		expect(merged).toHaveLength(2);
		const [first, second] = merged;
		expect(first?.conflictsWith).toEqual([second?.uid]);
		expect(second?.conflictsWith).toEqual([first?.uid]);
	});

	it("assigns stable uids F1..Fn", () => {
		const merged = dedupFindings([
			input("security", { id: "A", file: "a.js", title: "alpha issue here" }),
			input("code", { id: "B", file: "b.js", title: "beta other thing" }),
		]);
		expect(merged.map((f) => f.uid)).toEqual(["F1", "F2"]);
	});
});

const state = (
	uid: string,
	severity: "critical" | "high" | "medium" | "low",
	over: Partial<FindingState> = {},
): FindingState => ({
	uid,
	severity,
	confidence: "high",
	title: `finding ${uid}`,
	file: "src/a.js",
	lineStart: 1,
	lineEnd: 1,
	impact: "i",
	recommendation: "r",
	requirementIds: [],
	sources: [{ area: "security", id: uid, evidence: "e" }],
	conflictsWith: [],
	status: "open",
	refutation: null,
	...over,
});

const review = (area: "security" | "code", over: Partial<ReviewRecord> = {}): ReviewRecord => ({
	area,
	verdict: "pass",
	reason: null,
	commitSha: "head",
	acks: [],
	...over,
});

const base = (over: Partial<GateInput> = {}): GateInput => ({
	headCommit: "head",
	greenEvidence: true,
	expectedAreas: ["security", "code"],
	reviews: [review("security"), review("code")],
	findings: [],
	requiresReviewPaths: [],
	approver: "accept",
	repairBudgetRemains: true,
	...over,
});

describe("refutation", () => {
	it("marks refuted findings as refuted and keeps confirmed or uncertain open", () => {
		const applied = applyRefutation(
			[state("F1", "high"), state("F2", "critical"), state("F3", "high")],
			[
				{ id: "F1", outcome: "refuted", evidence: "guarded" },
				{ id: "F2", outcome: "confirmed", evidence: "reachable" },
				{ id: "F3", outcome: "uncertain", evidence: "cannot tell" },
			],
		);
		expect(applied.map((f) => [f.uid, f.status])).toEqual([
			["F1", "refuted"],
			["F2", "open"],
			["F3", "open"],
		]);
		expect(applied[0]?.refutation?.evidence).toBe("guarded");
	});

	it("selects only critical and high findings for the refuter", () => {
		expect(
			severeFindings([state("F1", "high"), state("F2", "medium"), state("F3", "critical")]).map(
				(f) => f.uid,
			),
		).toEqual(["F1", "F3"]);
	});
});

describe("G4 engine gate", () => {
	it("passes when every precondition holds", () => {
		expect(evaluateGate(base())).toEqual({ decision: "pass" });
	});

	it("passes with only medium/low findings or refuted severe ones", () => {
		expect(
			evaluateGate(base({ findings: [state("F1", "medium"), state("F2", "low")] })).decision,
		).toBe("pass");
		expect(
			evaluateGate(base({ findings: [state("F1", "high", { status: "refuted" })] })).decision,
		).toBe("pass");
	});

	it("E06: an open high authorization finding asks for repair, even if the approver says accept", () => {
		const outcome = evaluateGate(
			base({
				findings: [state("F1", "high", { title: "Broken authorization on /admin" })],
				approver: "accept",
			}),
		);
		expect(outcome).toMatchObject({ decision: "repair", open: ["F1"] });
	});

	it("uncertain refutations stay open", () => {
		const outcome = evaluateGate(
			base({
				findings: [
					state("F1", "critical", { refutation: { outcome: "uncertain", evidence: "?" } }),
				],
			}),
		);
		expect(outcome).toMatchObject({ decision: "repair", open: ["F1"] });
	});

	it("reports the areas that need a fresh review after a repair", () => {
		const outcome = evaluateGate(
			base({
				findings: [
					state("F1", "high", { sources: [{ area: "security", id: "x", evidence: "e" }] }),
				],
			}),
		);
		expect(outcome).toMatchObject({ decision: "repair", areas: ["security"] });
	});

	it("blocks when any reviewer is blocked, whatever the approver says", () => {
		const outcome = evaluateGate(
			base({
				reviews: [
					review("security", { verdict: "blocked", reason: "cannot inspect" }),
					review("code"),
				],
			}),
		);
		expect(outcome).toMatchObject({ decision: "blocked", reason: "review_blocked" });
	});

	it("blocks a missing expected review or a not_applicable without reason", () => {
		expect(evaluateGate(base({ reviews: [review("code")] }))).toMatchObject({
			decision: "blocked",
			reason: "review_incomplete",
		});
		expect(
			evaluateGate(
				base({ reviews: [review("security", { verdict: "not_applicable" }), review("code")] }),
			),
		).toMatchObject({ decision: "blocked", reason: "review_incomplete" });
		expect(
			evaluateGate(
				base({
					reviews: [
						review("security", { verdict: "not_applicable", reason: "static page" }),
						review("code"),
					],
				}),
			).decision,
		).toBe("pass");
	});

	it("blocks missing green evidence", () => {
		expect(evaluateGate(base({ greenEvidence: false }))).toMatchObject({
			decision: "blocked",
			reason: "evidence_missing",
		});
	});

	it("E07: a review of an older commit is always stale, even when clean", () => {
		expect(
			evaluateGate(base({ reviews: [review("security", { commitSha: "old" }), review("code")] })),
		).toMatchObject({ decision: "blocked", reason: "review_stale" });
		expect(
			evaluateGate(base({ reviews: [review("security"), review("code", { commitSha: "old" })] })),
		).toMatchObject({ decision: "blocked", reason: "review_stale" });
	});

	it("blocks unacknowledged requiresReview paths and accepts acknowledged ones", () => {
		expect(evaluateGate(base({ requiresReviewPaths: ["biome.json"] }))).toMatchObject({
			decision: "blocked",
			reason: "review_unacknowledged",
		});
		expect(
			evaluateGate(
				base({
					requiresReviewPaths: ["biome.json"],
					reviews: [
						review("security"),
						review("code", { acks: [{ path: "biome.json", decision: "ok" }] }),
					],
				}),
			).decision,
		).toBe("pass");
	});

	it("approver block wins even when everything else passes; accept and repair never override", () => {
		expect(evaluateGate(base({ approver: "block" }))).toMatchObject({
			decision: "blocked",
			reason: "approver_blocked",
		});
		expect(evaluateGate(base({ approver: "repair", repairBudgetRemains: false })).decision).toBe(
			"pass",
		);
		expect(evaluateGate(base({ approver: null }))).toMatchObject({
			decision: "blocked",
			reason: "review_incomplete",
		});
	});

	it.each([
		{ approver: "repair", budget: true, expected: "repair" },
		{ approver: "repair", budget: false, expected: "pass" },
		{ approver: "accept", budget: true, expected: "pass" },
		{ approver: "accept", budget: false, expected: "pass" },
	] as const)(
		"approver $approver with no open critical/high and repair budget=$budget gives $expected",
		({ approver, budget, expected }) => {
			expect(
				evaluateGate(
					base({ approver, repairBudgetRemains: budget, findings: [state("F1", "low")] }),
				).decision,
			).toBe(expected);
		},
	);

	it("approver block beats a repairable finding (most restrictive wins)", () => {
		expect(
			evaluateGate(base({ approver: "block", findings: [state("F1", "high")] })),
		).toMatchObject({ decision: "blocked", reason: "approver_blocked" });
	});

	it("approver accept cannot override blocked reviewers, stale reviews or missing acks", () => {
		const accept = { approver: "accept" as const };
		expect(
			evaluateGate(
				base({
					...accept,
					reviews: [review("security", { verdict: "blocked", reason: "r" }), review("code")],
				}),
			).decision,
		).toBe("blocked");
		expect(evaluateGate(base({ ...accept, greenEvidence: false })).decision).toBe("blocked");
		expect(evaluateGate(base({ ...accept, requiresReviewPaths: ["x"] })).decision).toBe("blocked");
	});
});
