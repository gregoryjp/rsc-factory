import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRun } from "../src/modules/execution/build-run.js";
import { commitGuarded } from "../src/modules/execution/safe-commit.js";
import { getRunStatus } from "../src/modules/runs/get-run-status.js";
import {
	approverSays,
	type BuildEnv,
	blockedReview,
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

const gitOut = (cwd: string, args: string[]) =>
	spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { PATH: process.env.PATH ?? "" },
	}).stdout.trim();

const run = async (
	env: BuildEnv,
	options: Parameters<typeof buildRun>[1] extends infer T ? Partial<T> : never = {},
) => {
	const result = await buildRun(env.deps, { runId: env.runId, ...options });
	if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.value;
};

const base = [completed(redTest("add")), completed(greenImpl("add"))];
const repairEdit = completed({
	writes: { "src/add.js": "export const add = () => 1;\nexport const guard = (value) => value;\n" },
});

const reviewsOf = (env: BuildEnv) => env.storage.reviews.listReviews(env.taskIds.add ?? "", 0);
const findingsOf = (env: BuildEnv) => env.storage.reviews.listFindings(env.taskIds.add ?? "", 0);

describe("reviewers in the build loop", () => {
	it("runs security and code reviewers read-only on a snapshot of the reviewed commit, then deletes it", async () => {
		const seen: { cwd: string; exists: boolean; hasGit: boolean; hasSource: boolean }[] = [];
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: base,
			reviewHook: (request) =>
				request.role?.startsWith("reviewer-") &&
				seen.push({
					cwd: request.cwd,
					exists: existsSync(request.cwd),
					hasGit: existsSync(join(request.cwd, ".git")),
					hasSource: existsSync(join(request.cwd, "src", "add.js")),
				}),
		});
		const summary = await run(env);
		expect(summary.tasks[0]?.outcome).toBe("done");
		const calls = [...env.roleCalls("reviewer-security"), ...env.roleCalls("reviewer-code")];
		expect(calls).toHaveLength(2);
		for (const call of calls) {
			expect(call).toMatchObject({
				restricted: true,
				permissionMode: "dontAsk",
				tools: ["Read", "Glob", "Grep"],
				model: "sonnet",
			});
			expect(JSON.stringify(call.tools)).not.toMatch(/Edit|Write|Bash/);
			expect(call.cwd).toContain(join(env.home, "runs", env.runId, "review-work"));
			expect(existsSync(call.cwd)).toBe(false);
		}
		expect(seen.every((s) => s.exists && !s.hasGit && s.hasSource)).toBe(true);
		expect(new Set(seen.map((s) => s.cwd)).size).toBe(2);
		expect(env.roleCalls("approver")[0]).toMatchObject({ tools: [] });
		expect(env.roleCalls("review-refuter")).toHaveLength(0);
	});

	it("binds persisted reviews to the exact commit and spec version, with an artifact each", async () => {
		const env = await createBuildEnv({ tasks: [task("add")], builder: base });
		await run(env);
		const taskHead = gitOut(env.target, ["rev-parse", "factory/task/add"]);
		const reviews = reviewsOf(env);
		expect(reviews.map((r) => [r.area, r.verdict, r.commitSha, r.specVersion])).toEqual([
			["security", "pass", taskHead, 1],
			["code", "pass", taskHead, 1],
			["ux", "not_applicable", taskHead, 1],
			["ui", "not_applicable", taskHead, 1],
		]);
		for (const review of reviews) {
			const artifact = env.storage.artifacts
				.list(env.runId)
				.find((a) => a.id === review.artifactId);
			expect(artifact?.kind).toBe("review");
			expect(existsSync(join(env.home, "runs", env.runId, artifact?.path ?? "missing"))).toBe(true);
		}
		expect(env.buildOf("add")).toMatchObject({ phase: "done", reviewedCommit: taskHead });
		expect(env.events("task.review_gate")[0]?.payload).toMatchObject({ decision: "pass" });
		expect(env.eventTypes().indexOf("task.review_gate")).toBeLessThan(
			env.eventTypes().indexOf("task.integrated"),
		);
	});

	it("gives reviewers the diff, check summaries and requiresReview paths as delimited data", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [
				completed(redTest("add")),
				completed({ writes: { ...greenImpl("add").writes, "tsconfig.json": "{}\n" } }),
			],
			reviewers: { code: [passReview("code", ["tsconfig.json"])] },
		});
		const summary = await run(env);
		expect(summary.tasks[0]?.outcome).toBe("done");
		const prompt = env.roleCalls("reviewer-code")[0]?.prompt ?? "";
		expect(prompt).toMatch(/BEGIN_DIFF_[0-9a-f]{16}/);
		expect(prompt).toContain("+export const add = () => 1;");
		expect(prompt).toMatch(/BEGIN_REQUIRES_REVIEW_[0-9a-f]{16}/);
		expect(prompt).toContain("tsconfig.json");
		expect(prompt).toMatch(/BEGIN_CHECKS_[0-9a-f]{16}/);
		expect(prompt).toMatch(/BEGIN_CONTEXT_PACK_[0-9a-f]{16}/);
		expect(env.roleCalls("reviewer-security")[0]?.prompt).not.toContain("BEGIN_REQUIRES_REVIEW");
	});

	it("rejects a code review that misses an ack, repairs once with feedback, then accepts", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [
				completed(redTest("add")),
				completed({ writes: { ...greenImpl("add").writes, "tsconfig.json": "{}\n" } }),
			],
			reviewers: { code: [passReview("code"), passReview("code", ["tsconfig.json"])] },
		});
		const summary = await run(env);
		expect(summary.tasks[0]?.outcome).toBe("done");
		const calls = env.roleCalls("reviewer-code");
		expect(calls).toHaveLength(2);
		expect(calls[1]?.prompt).toContain("Missing requiresReviewAck for tsconfig.json");
	});

	it("blocks review_output_invalid when a reviewer stays malformed after the bounded repair", async () => {
		const bad = findingsReview("security", [reviewFinding({ file: undefined })]);
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: base,
			reviewers: { security: [bad, bad] },
		});
		const summary = await run(env);
		expect(summary.tasks[0]).toMatchObject({ outcome: "blocked", reason: "review_output_invalid" });
		expect(env.roleCalls("reviewer-security")).toHaveLength(2);
		expect(env.events("task.integrated")).toHaveLength(0);
		expect(env.git.headSha(env.target)).toEqual({ ok: true, value: env.bootstrapSha });
	});

	it("never passes by default: a blocked reviewer blocks the task as review_blocked", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: base,
			reviewers: { security: [blockedReview("security", "cannot inspect the snapshot")] },
		});
		const summary = await run(env);
		expect(summary.tasks[0]).toMatchObject({ outcome: "blocked", reason: "review_blocked" });
		expect(env.roleCalls("approver")).toHaveLength(0);
		expect(env.taskOf("add").state).toBe("BLOCKED");
	});

	it("a provider failure of a reviewer also blocks as review_blocked", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: base,
			reviewers: {
				security: [
					{
						ok: false,
						error: { kind: "provider_error", retryable: false, message: "boom", costUsd: null },
					},
				],
			},
		});
		const summary = await run(env);
		expect(summary.tasks[0]).toMatchObject({ outcome: "blocked", reason: "review_blocked" });
	});

	it("an approver block stops the task even when every reviewer passes", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: base,
			reviewers: { approver: [approverSays("block")] },
		});
		const summary = await run(env);
		expect(summary.tasks[0]).toMatchObject({ outcome: "blocked", reason: "approver_blocked" });
	});

	it("E07: a commit added to the task branch during review invalidates the reviews", async () => {
		const holder: { env?: BuildEnv } = {};
		let injected = false;
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: base,
			reviewHook: () => {
				const current = holder.env;
				if (!current || injected) return;
				injected = true;
				const worktree = join(current.home, "runs", current.runId, "worktrees", "add");
				writeFileSync(join(worktree, "src", "extra.js"), "export const extra = 1;\n");
				commitGuarded(current.git, worktree, "chore: sneak in unreviewed code");
			},
		});
		holder.env = env;
		const summary = await run(env);
		expect(injected).toBe(true);
		expect(summary.tasks[0]).toMatchObject({ outcome: "blocked", reason: "review_stale" });
		expect(env.git.headSha(env.target)).toEqual({ ok: true, value: env.bootstrapSha });
		expect(env.events("task.integrated")).toHaveLength(0);
	});

	it("fails explicitly with diff_too_large instead of truncating the diff", async () => {
		const env = await createBuildEnv({ tasks: [task("add")], builder: base });
		const summary = await run(env, { reviewDiffMaxBytes: 10 });
		expect(summary.tasks[0]).toMatchObject({ outcome: "blocked", reason: "diff_too_large" });
		expect(env.roleCalls("reviewer-security")).toHaveLength(0);
		expect(env.roleCalls("reviewer-code")).toHaveLength(0);
	});
});

describe("findings, refuter and repair", () => {
	it("repairs open findings, re-reviews the new head and merges only reviewed code (E06)", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [...base, repairEdit],
			reviewers: {
				security: [findingsReview("security", [reviewFinding()]), passReview("security")],
				code: [passReview("code"), passReview("code")],
				refuter: [refuterOutcomes([{ id: "F1", outcome: "confirmed" }])],
				approver: [
					approverSays("repair", [{ findingIds: ["F1"], instruction: "validate the input first" }]),
					approverSays("accept"),
				],
			},
		});
		const summary = await run(env);
		expect(summary.tasks[0]?.outcome).toBe("done");
		expect(env.roleCalls("reviewer-security")).toHaveLength(2);
		expect(env.roleCalls("reviewer-code")).toHaveLength(2);
		expect(env.roleCalls("review-refuter")).toHaveLength(1);
		const repairCall = env.builderCalls()[2];
		expect(repairCall?.systemPrompt).toContain("review findings");
		expect(repairCall?.prompt).toContain("Unvalidated input reaches the handler");
		expect(repairCall?.prompt).toContain("validate the input first");
		expect(repairCall?.prompt).toMatch(/BEGIN_FINDINGS_[0-9a-f]{16}/);
		const taskHead = gitOut(env.target, ["rev-parse", "factory/task/add"]);
		const reviews = reviewsOf(env);
		const commits = [...new Set(reviews.map((r) => r.commitSha))];
		expect(commits).toHaveLength(2);
		expect(commits[1]).toBe(taskHead);
		expect(reviews.filter((r) => r.commitSha === taskHead).map((r) => r.area)).toEqual([
			"security",
			"code",
			"ux",
			"ui",
		]);
		const passingChecks = env.storage.checks
			.listByRun(env.runId)
			.filter((c) => c.taskId === env.taskIds.add && c.exitCode === 0)
			.map((c) => c.commitSha);
		expect(passingChecks).toContain(taskHead);
		expect(env.buildOf("add")).toMatchObject({ repairs: 1, reviewedCommit: taskHead });
		expect(findingsOf(env).map((f) => [f.commitSha === taskHead, f.status])).toEqual([
			[false, "open"],
		]);
	});

	it("re-runs every review area on the new head after a repair; an old clean review never satisfies the gate", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [...base, repairEdit],
			reviewers: {
				security: [passReview("security"), passReview("security")],
				code: [
					findingsReview("code", [reviewFinding({ id: "C1", title: "Weak input handling" })]),
					passReview("code"),
				],
				refuter: [refuterOutcomes([{ id: "F1", outcome: "confirmed" }])],
				approver: [approverSays("repair"), approverSays("accept")],
			},
		});
		const summary = await run(env);
		expect(summary.tasks[0]?.outcome).toBe("done");
		expect(env.roleCalls("reviewer-security")).toHaveLength(2);
		expect(env.roleCalls("reviewer-code")).toHaveLength(2);
		const reviews = reviewsOf(env);
		const heads = [...new Set(reviews.map((r) => r.commitSha))];
		expect(heads).toHaveLength(2);
		for (const head of heads) {
			expect(reviews.filter((r) => r.commitSha === head).map((r) => r.area)).toEqual([
				"security",
				"code",
				"ux",
				"ui",
			]);
		}
	});

	it("counts reviewer, refuter and approver calls against --max-provider-calls and resumes without repeating reviewer calls", async () => {
		const env = await createBuildEnv({ tasks: [task("add")], builder: base });
		const first = await run(env, { maxProviderCalls: 3 });
		expect(first.stoppedBecause).toBe("max_provider_calls");
		expect(first.providerCalls).toBe(3);
		expect(first.tasks[0]).toMatchObject({ key: "add", outcome: "released" });
		const released = env.taskOf("add");
		expect(released.state).toBe("READY");
		expect(released.leaseOwner).toBeNull();
		expect(env.buildOf("add")?.phase).toBe("reviewing");
		expect(reviewsOf(env).map((r) => r.area)).toEqual(["security"]);
		expect(env.events("task.review_gate")).toHaveLength(0);
		const second = await run(env, { maxProviderCalls: 1 });
		expect(second.stoppedBecause).toBe("max_provider_calls");
		expect(reviewsOf(env).map((r) => r.area)).toEqual(["security", "code", "ux", "ui"]);
		expect(env.roleCalls("approver")).toHaveLength(0);
		expect(env.buildOf("add")?.phase).toBe("reviewing");
		const third = await run(env);
		expect(third.tasks[0]?.outcome).toBe("done");
		expect(env.roleCalls("reviewer-security")).toHaveLength(1);
		expect(env.roleCalls("reviewer-code")).toHaveLength(1);
		expect(env.roleCalls("approver")).toHaveLength(1);
	});

	it("stops cleanly when the budget runs out before the refuter", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: base,
			reviewers: {
				security: [findingsReview("security", [reviewFinding()])],
				refuter: [refuterOutcomes([{ id: "F1", outcome: "refuted" }])],
			},
		});
		const first = await run(env, { maxProviderCalls: 4 });
		expect(first.stoppedBecause).toBe("max_provider_calls");
		expect(env.roleCalls("review-refuter")).toHaveLength(0);
		expect(env.taskOf("add").state).toBe("READY");
		expect(env.events("task.review_gate")).toHaveLength(0);
		const second = await run(env);
		expect(second.tasks[0]?.outcome).toBe("done");
		expect(env.roleCalls("reviewer-security")).toHaveLength(1);
		expect(env.roleCalls("review-refuter")).toHaveLength(1);
	});

	it("runs the approver in an empty directory under the run, not in the factory home", async () => {
		const cwds: { cwd: string; entries: string[] }[] = [];
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: base,
			reviewHook: (request) =>
				request.role === "approver" &&
				cwds.push({ cwd: request.cwd, entries: readdirSync(request.cwd) }),
		});
		await run(env);
		const call = env.roleCalls("approver")[0];
		expect(call?.cwd).toContain(join(env.home, "runs", env.runId, "approver-work"));
		expect(call?.cwd).not.toBe(env.home);
		expect(cwds[0]?.entries).toEqual([]);
		expect(existsSync(call?.cwd ?? "")).toBe(false);
	});

	it("approver repair without critical/high findings runs one repair round while budget remains, then passes when exhausted", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [...base, repairEdit],
			reviewers: {
				security: [
					findingsReview("security", [reviewFinding({ severity: "low", id: "L1" })]),
					passReview("security"),
				],
				approver: [approverSays("repair"), approverSays("accept")],
			},
		});
		const summary = await run(env);
		expect(summary.tasks[0]?.outcome).toBe("done");
		expect(env.buildOf("add")?.repairs).toBe(1);
		expect(env.roleCalls("reviewer-security")).toHaveLength(2);
		expect(env.roleCalls("reviewer-code")).toHaveLength(2);
	});

	it("a refuted high finding no longer blocks but is kept with its refutation", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: base,
			reviewers: {
				security: [findingsReview("security", [reviewFinding()])],
				refuter: [refuterOutcomes([{ id: "F1", outcome: "refuted" }])],
			},
		});
		const summary = await run(env);
		expect(summary.tasks[0]?.outcome).toBe("done");
		expect(env.builderCalls()).toHaveLength(2);
		const [stored] = findingsOf(env);
		expect(stored).toMatchObject({ uid: "F1", severity: "high", status: "refuted" });
		expect(stored?.refutation).toEqual({ outcome: "refuted", evidence: "evidence for F1" });
		const refuterCall = env.roleCalls("review-refuter")[0];
		expect(refuterCall).toMatchObject({
			restricted: true,
			permissionMode: "dontAsk",
			tools: ["Read", "Glob", "Grep"],
		});
		expect(refuterCall?.prompt).toContain("Unvalidated input reaches the handler");
		const status = getRunStatus(env.deps, { runId: env.runId, eventLimit: 5 });
		if (!status.ok) throw new Error(status.error.message);
		expect(status.value.planning.reviews).toEqual([
			expect.objectContaining({ key: "add", openSevere: 0, refuted: 1, minor: 0 }),
		]);
	});

	it("an uncertain refutation keeps the finding blocking and stores a blocked-diff artifact", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: base,
			reviewers: {
				security: [findingsReview("security", [reviewFinding()])],
				refuter: [refuterOutcomes([{ id: "F1", outcome: "uncertain" }])],
			},
		});
		const summary = await run(env, { repairsPerTask: 0 });
		expect(summary.tasks[0]).toMatchObject({ outcome: "blocked", reason: "review_findings_open" });
		expect(env.git.headSha(env.target)).toEqual({ ok: true, value: env.bootstrapSha });
		const diff = env.storage.artifacts.latest(env.runId, "blocked-diff", env.taskIds.add ?? "");
		expect(diff).toBeDefined();
		const text = readFileSync(join(env.home, "runs", env.runId, diff?.path ?? "missing"), "utf8");
		expect(text).toContain("src/add.js");
		expect(text).toContain("+export const add = () => 1;");
		const status = getRunStatus(env.deps, { runId: env.runId, eventLimit: 5 });
		if (!status.ok) throw new Error(status.error.message);
		expect(status.value.planning.blockedTasks).toEqual([
			{
				key: "add",
				reason: "review_findings_open",
				blockedDiff: `runs/${env.runId}/${diff?.path}`,
			},
		]);
	});

	it("persisting findings blocks as review_findings_open after the shared repair budget", async () => {
		const high = findingsReview("security", [reviewFinding()]);
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [...base, repairEdit],
			reviewers: {
				security: [high, high],
				code: [passReview("code"), passReview("code")],
				refuter: [
					refuterOutcomes([{ id: "F1", outcome: "confirmed" }]),
					refuterOutcomes([{ id: "F1", outcome: "confirmed" }]),
				],
				approver: [approverSays("repair"), approverSays("repair")],
			},
		});
		const summary = await run(env, { repairsPerTask: 1 });
		expect(summary.tasks[0]).toMatchObject({ outcome: "blocked", reason: "review_findings_open" });
		expect(env.builderCalls()).toHaveLength(3);
		expect(env.buildOf("add")).toMatchObject({ repairs: 1, blockedReason: "review_findings_open" });
		expect(env.git.headSha(env.target)).toEqual({ ok: true, value: env.bootstrapSha });
		expect(
			env.storage.artifacts.latest(env.runId, "blocked-diff", env.taskIds.add ?? ""),
		).toBeDefined();
	});

	it("does not call the refuter when there are only medium or low findings", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: base,
			reviewers: {
				code: [
					findingsReview("code", [
						reviewFinding({ id: "C1", severity: "medium", file: undefined }),
					]),
				],
			},
		});
		const summary = await run(env);
		expect(summary.tasks[0]?.outcome).toBe("done");
		expect(env.roleCalls("review-refuter")).toHaveLength(0);
		expect(findingsOf(env).map((f) => f.severity)).toEqual(["medium"]);
	});

	it("merges duplicate findings from both reviewers into one and sends one refuter entry", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: base,
			reviewers: {
				security: [findingsReview("security", [reviewFinding()])],
				code: [findingsReview("code", [reviewFinding({ id: "C1", evidence: "second opinion" })])],
				refuter: [refuterOutcomes([{ id: "F1", outcome: "refuted" }])],
			},
		});
		await run(env);
		const [only, ...rest] = findingsOf(env);
		expect(rest).toHaveLength(0);
		expect(only?.sources.map((s) => s.area)).toEqual(["security", "code"]);
		expect(env.roleCalls("review-refuter")[0]?.prompt.match(/"uid": "F\d+"/g)).toHaveLength(1);
	});
});

describe("blocked-diff", () => {
	it("keeps the worktree diff when a protected change blocks the task", async () => {
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [
				completed(redTest("add")),
				completed({
					writes: {
						...greenImpl("add").writes,
						"package.json": JSON.stringify({ name: "p", scripts: { test: "true", check: "true" } }),
					},
				}),
			],
		});
		const summary = await run(env);
		expect(summary.tasks[0]).toMatchObject({ outcome: "blocked", reason: "protected_change" });
		const diff = env.storage.artifacts.latest(env.runId, "blocked-diff", env.taskIds.add ?? "");
		const text = readFileSync(join(env.home, "runs", env.runId, diff?.path ?? "missing"), "utf8");
		expect(text).toContain("package.json");
		expect(text).toContain("src/add.js");
	});

	it("never stores a raw secret in the blocked-diff artifact and records the rules that matched", async () => {
		const secret = "sk_live_abcdefghijklmnop1234";
		const env = await createBuildEnv({
			tasks: [task("add")],
			builder: [
				completed(redTest("add")),
				completed({
					writes: {
						...greenImpl("add").writes,
						"src/cfg.js": `export const apiKey = "${secret}";\n`,
						"package.json": JSON.stringify({ name: "p", scripts: { test: "true", check: "true" } }),
					},
				}),
			],
		});
		const summary = await run(env);
		expect(summary.tasks[0]?.outcome).toBe("blocked");
		const diff = env.storage.artifacts.latest(env.runId, "blocked-diff", env.taskIds.add ?? "");
		const text = readFileSync(join(env.home, "runs", env.runId, diff?.path ?? "missing"), "utf8");
		expect(text).not.toContain(secret);
		expect(text).toContain("[REDACTED:secret_assignment]");
		const note = env
			.events("task.phase_changed")
			.find((e) => e.payload.phase === "blocked_diff_redacted");
		expect(note?.payload.rules).toEqual(["secret_assignment"]);
	});
});
