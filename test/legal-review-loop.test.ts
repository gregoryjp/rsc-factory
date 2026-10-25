import { describe, expect, it } from "vitest";
import { buildRun } from "../src/modules/execution/build-run.js";
import {
	approverSays,
	type BuildEnv,
	completed,
	createBuildEnv,
	findingsReview,
	greenImpl,
	passReview,
	redTest,
	refuterOutcomes,
	reviewFinding,
	task,
} from "./helpers/build-env.js";

const run = async (env: BuildEnv) => {
	const result = await buildRun(env.deps, { runId: env.runId });
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.value;
};

const personalGreen = completed({
	writes: {
		...greenImpl("add").writes,
		"src/session.js": "export const remember = (v) => localStorage.setItem('u', v);\n",
	},
});
const repairEdit = completed({
	writes: { "src/consent.js": "export const consent = () => true;\n" },
});
const reviewsOf = (env: BuildEnv) => env.storage.reviews.listReviews(env.taskIds.add ?? "", 0);

const legalFinding = reviewFinding({
	id: "L1",
	title: "No deletion path for stored user data",
	file: "src/session.js",
	evidence: "localStorage.setItem stores the user with no removal path",
	recommendation: "add a deletion path",
});

describe("legal reviewer in the build loop", () => {
	it("skips the provider and records not_applicable when nothing touches personal data", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [completed(redTest("add")), completed(greenImpl("add"))],
		});
		const summary = await run(env);
		expect(summary.tasks[0]?.outcome).toBe("done");
		expect(env.roleCalls("reviewer-legal")).toHaveLength(0);
		const legal = reviewsOf(env).find((r) => r.area === "legal");
		expect(legal).toMatchObject({
			verdict: "not_applicable",
			reason: "no personal data processing detected",
		});
	});

	it("runs the read-only legal reviewer when the diff stores data and passes on a clean review", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [completed(redTest("add")), personalGreen],
			reviewers: { legal: [passReview("legal")] },
		});
		const summary = await run(env);
		expect(summary.tasks[0]?.outcome).toBe("done");
		const calls = env.roleCalls("reviewer-legal");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			restricted: true,
			permissionMode: "dontAsk",
			tools: ["Read", "Glob", "Grep"],
			model: "sonnet",
		});
		expect(reviewsOf(env).map((r) => [r.area, r.verdict])).toEqual([
			["security", "pass"],
			["code", "pass"],
			["legal", "pass"],
			["ux", "not_applicable"],
			["ui", "not_applicable"],
		]);
	});

	it("repairs a legal finding and re-reviews every area on the new head", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [completed(redTest("add")), personalGreen, repairEdit],
			reviewers: {
				security: [passReview("security"), passReview("security")],
				code: [passReview("code"), passReview("code")],
				legal: [findingsReview("legal", [legalFinding]), passReview("legal")],
				refuter: [refuterOutcomes([{ id: "F1", outcome: "confirmed" }])],
				approver: [
					approverSays("repair", [{ findingIds: ["F1"], instruction: "add a deletion path" }]),
					approverSays("accept"),
				],
			},
		});
		const summary = await run(env);
		expect(summary.tasks[0]?.outcome).toBe("done");
		expect(env.roleCalls("reviewer-legal")).toHaveLength(2);
		expect(env.roleCalls("reviewer-security")).toHaveLength(2);
		expect(env.roleCalls("reviewer-code")).toHaveLength(2);
		const reviews = reviewsOf(env);
		const heads = [...new Set(reviews.map((r) => r.commitSha))];
		expect(heads).toHaveLength(2);
		for (const head of heads) {
			expect(reviews.filter((r) => r.commitSha === head).map((r) => r.area)).toEqual([
				"security",
				"code",
				"legal",
				"ux",
				"ui",
			]);
		}
		const repairCall = env.builderCalls()[2];
		expect(repairCall?.prompt).toContain("No deletion path for stored user data");
	});

	it("a blocked legal reviewer blocks the task and never passes", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [completed(redTest("add")), personalGreen],
			reviewers: {
				legal: [
					{
						ok: true,
						value: {
							output: {
								area: "legal",
								verdict: "blocked",
								reason: "could not inspect the schema",
								findings: [],
								requiresReviewAck: [],
							},
							costUsd: null,
							models: ["fake"],
						},
					},
				],
			},
		});
		const summary = await run(env);
		expect(summary.tasks[0]).toMatchObject({ outcome: "blocked", reason: "review_blocked" });
		expect(env.events("task.integrated")).toHaveLength(0);
	});
});
