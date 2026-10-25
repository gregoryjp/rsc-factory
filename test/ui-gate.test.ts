import { describe, expect, it } from "vitest";
import type { ReviewArea } from "../src/contracts/review.js";
import { evaluateGate } from "../src/domain/review/gate.js";
import type { ReviewRecord } from "../src/domain/review/types.js";

const HEAD = "a".repeat(40);
const AREAS: ReviewArea[] = ["security", "code", "legal", "ux", "ui"];

const record = (area: ReviewArea, over: Partial<ReviewRecord> = {}): ReviewRecord => ({
	area,
	verdict: "pass",
	reason: null,
	commitSha: HEAD,
	acks: [],
	...over,
});

const gate = (reviews: ReviewRecord[], approver: "accept" | "repair" | "block" = "accept") =>
	evaluateGate({
		headCommit: HEAD,
		greenEvidence: true,
		expectedAreas: AREAS,
		reviews,
		findings: [],
		requiresReviewPaths: [],
		approver,
		repairBudgetRemains: false,
	});

describe("gate G4 with five areas", () => {
	it("passes when all five areas pass", () => {
		expect(gate(AREAS.map((area) => record(area)))).toEqual({ decision: "pass" });
	});

	it("passes with ux and ui not_applicable carrying the engine reason", () => {
		const reviews = [
			record("security"),
			record("code"),
			record("legal", {
				verdict: "not_applicable",
				reason: "no personal data processing detected",
			}),
			record("ux", { verdict: "not_applicable", reason: "no UI changes" }),
			record("ui", { verdict: "not_applicable", reason: "no UI changes" }),
		];
		expect(gate(reviews)).toEqual({ decision: "pass" });
	});

	it("is incomplete when the legal review is missing", () => {
		const decision = gate(AREAS.filter((a) => a !== "legal").map((a) => record(a)));
		expect(decision).toMatchObject({
			decision: "blocked",
			reason: "review_incomplete",
			detail: expect.stringContaining("legal"),
		});
	});

	it("a blocked legal review blocks the gate even when the approver accepts", () => {
		const reviews = AREAS.map((a) =>
			a === "legal" ? record(a, { verdict: "blocked", reason: "could not inspect" }) : record(a),
		);
		expect(gate(reviews, "accept")).toMatchObject({
			decision: "blocked",
			reason: "review_blocked",
			detail: expect.stringContaining("legal"),
		});
	});

	it("rejects a legal not_applicable without an engine reason and a stale legal review", () => {
		const noReason = AREAS.map((a) =>
			a === "legal" ? record(a, { verdict: "not_applicable" }) : record(a),
		);
		expect(gate(noReason)).toMatchObject({ decision: "blocked", reason: "review_incomplete" });
		const stale = AREAS.map((a) =>
			a === "legal" ? record(a, { commitSha: "b".repeat(40) }) : record(a),
		);
		expect(gate(stale)).toMatchObject({ decision: "blocked", reason: "review_stale" });
	});

	it("is incomplete when ux or ui is missing", () => {
		const decision = gate([record("security"), record("code"), record("ux")]);
		expect(decision).toMatchObject({
			decision: "blocked",
			reason: "review_incomplete",
			detail: expect.stringContaining("ui"),
		});
	});

	it("E15: a blocked ux or ui review blocks the gate and an approver accept cannot override it", () => {
		for (const area of ["ux", "ui"] as const) {
			const reviews = AREAS.map((a) =>
				a === area
					? record(a, { verdict: "blocked", reason: "browser evidence unavailable: docker down" })
					: record(a),
			);
			expect(gate(reviews, "accept")).toMatchObject({
				decision: "blocked",
				reason: "review_blocked",
			});
		}
	});

	it("rejects not_applicable without a reason and a stale ui review", () => {
		const noReason = AREAS.map((a) =>
			a === "ui" ? record(a, { verdict: "not_applicable" }) : record(a),
		);
		expect(gate(noReason)).toMatchObject({ decision: "blocked", reason: "review_incomplete" });
		const stale = AREAS.map((a) =>
			a === "ui" ? record(a, { commitSha: "b".repeat(40) }) : record(a),
		);
		expect(gate(stale)).toMatchObject({ decision: "blocked", reason: "review_stale" });
	});
});
