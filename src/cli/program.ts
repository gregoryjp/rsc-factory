import { resolve } from "node:path";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { EXPECTED_CLAUDE_VERSION, EXPECTED_CODEX_VERSION } from "../config/compatibility.js";
import type { Config } from "../config/env.js";
import { DeliveryTargetSchema } from "../contracts/states.js";
import { renderReportJson, renderReportMarkdown } from "../domain/report/render.js";
import { readCodexModelSlugs } from "../infrastructure/fs/codex-models.js";
import { createFsFactoryFiles } from "../infrastructure/fs/factory-files.js";
import { execCommand } from "../infrastructure/process.js";
import { MIGRATIONS } from "../infrastructure/storage/migrations.js";
import { openStorage } from "../infrastructure/storage/sqlite-storage.js";
import { auditRepo } from "../modules/audit/audit-repo.js";
import { loadBudgetConfig } from "../modules/budget/load-config.js";
import { buildRunReport } from "../modules/delivery/build-report.js";
import { deliverRun } from "../modules/delivery/deliver-run.js";
import { prepareRelease } from "../modules/delivery/release.js";
import { type RunAllResult, runAll } from "../modules/delivery/run-all.js";
import { runDoctor } from "../modules/doctor/run-doctor.js";
import {
	buildBootstrapOnly,
	buildRun,
	DEFAULT_MAX_PROVIDER_CALLS,
} from "../modules/execution/build-run.js";
import { retryTask } from "../modules/execution/retry-task.js";
import { planRun } from "../modules/planning/plan-run.js";
import { loadRolesConfig } from "../modules/planning/roles-config.js";
import { addBudget } from "../modules/runs/add-budget.js";
import { cancelRun } from "../modules/runs/cancel-run.js";
import { getRunStatus } from "../modules/runs/get-run-status.js";
import { resumeRun } from "../modules/runs/resume-run.js";
import { startRun } from "../modules/runs/start-run.js";
import type { Failure, Result } from "../shared/result.js";
import { fail, ok } from "../shared/result.js";
import { openRuntime, type Runtime } from "./runtime.js";

export type CliIo = { out: (line: string) => void; error: (line: string) => void };

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_PAUSED = 3;

const RUN_EXIT: Record<RunAllResult, number> = {
	delivered: EXIT_OK,
	paused_budget: EXIT_PAUSED,
	paused_quota: EXIT_PAUSED,
	paused_limit: EXIT_PAUSED,
	blocked: EXIT_FAILURE,
	failed: EXIT_FAILURE,
	canceled: EXIT_FAILURE,
};

const EVENT_LIMIT = 10;
const OPERATOR_STOPS: ReadonlySet<string> = new Set([
	"final_check_failed",
	"budget_exhausted",
	"quota_wait",
	"run_canceled",
]);

const parsePositive = (value: string): number => {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new InvalidArgumentError("expected a positive integer");
	}
	return parsed;
};
const parsePositiveUsd = (value: string): number => {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new InvalidArgumentError("expected a positive amount in USD");
	}
	return parsed;
};
const STATUS_ICON = { ok: "OK  ", warn: "WARN", fail: "FAIL" } as const;

export const runCli = async (
	argv: readonly string[],
	config: Config,
	io: CliIo,
): Promise<number> => {
	let exitCode = EXIT_OK;
	const reportFailure = (failure: Failure) => {
		io.error(`error [${failure.code}]: ${failure.message}`);
		exitCode = EXIT_FAILURE;
	};
	const handle = <T>(result: Result<T, Failure>, onOk: (value: T) => void) => {
		if (result.ok) onOk(result.value);
		else reportFailure(result.error);
	};
	const withRuntime = async (work: (runtime: Runtime) => void | Promise<void>) => {
		const runtime = openRuntime(config);
		try {
			await work(runtime);
		} finally {
			runtime.close();
		}
	};
	const print = (json: boolean, value: unknown, human: () => string[]) => {
		for (const line of json ? [JSON.stringify(value, null, 2)] : human()) io.out(line);
	};

	const program = new Command("factory")
		.description("Gregory Software Factory engine")
		.exitOverride()
		.configureOutput({
			writeOut: (s) => io.out(s.trimEnd()),
			writeErr: (s) => io.error(s.trimEnd()),
		});

	program
		.command("doctor")
		.description("Check the local environment")
		.action(async () => {
			const report = await runDoctor({
				exec: execCommand,
				nodeVersion: process.versions.node,
				factoryHome: config.factoryHome,
				expectedClaudeVersion: EXPECTED_CLAUDE_VERSION,
				expectedCodexVersion: EXPECTED_CODEX_VERSION,
				codexBin: config.codexBin,
				codexHostUnsafe: config.codexHostUnsafe,
				roles: loadRolesConfig(createFsFactoryFiles({ repoRoot: config.repoRoot })),
				codexModels: readCodexModelSlugs(config.codexHome),
				provider: config.provider,
				runnerPreference: config.runnerPreference,
				expectedMigrations: MIGRATIONS.map((m) => m.version),
				checkMigrations: () => {
					try {
						const storage = openStorage({ file: config.dbFile });
						const applied = storage.appliedMigrations();
						storage.close();
						return ok(applied);
					} catch (cause) {
						return fail("db_unavailable", cause instanceof Error ? cause.message : "unknown error");
					}
				},
			});
			for (const c of report.checks) io.out(`${STATUS_ICON[c.status]} ${c.name}: ${c.detail}`);
			if (report.hasFailure) exitCode = EXIT_FAILURE;
		});

	program
		.command("start")
		.description("Create a run from a PRD (reuses an identical non-terminal run unless --new)")
		.requiredOption("--prd <path>", "path to the PRD file")
		.requiredOption("--target <dir>", "directory where the product will be built")
		.option("--project <name>", "project name (defaults to the current directory name)")
		.option("--new", "force a new run even if an identical one is active")
		.option(
			"--budget-usd <n>",
			"run budget in USD (default: defaultRunBudgetUsd of factory/config/budget.json)",
			parsePositiveUsd,
		)
		.addOption(
			new Option("--delivery <target>", "declared delivery target").choices(
				DeliveryTargetSchema.options,
			),
		)
		.option("--json", "machine-readable output")
		.action(
			(opts: {
				prd: string;
				target: string;
				project?: string;
				new?: boolean;
				delivery?: "local" | "production";
				budgetUsd?: number;
				json?: boolean;
			}) =>
				withRuntime(({ deps }) => {
					const budget = loadBudgetConfig(createFsFactoryFiles({ repoRoot: config.repoRoot }));
					if (!budget.ok) return reportFailure(budget.error);
					const result = startRun(deps, {
						budgetUsd: opts.budgetUsd ?? budget.value.defaultRunBudgetUsd,
						prdPath: opts.prd,
						targetPath: opts.target,
						projectName: opts.project,
						cwd: process.cwd(),
						forceNew: opts.new === true,
						deliveryTarget: opts.delivery ?? null,
					});
					handle(result, ({ run, reused }) =>
						print(opts.json === true, { runId: run.id, reused, state: run.state }, () => [
							...(reused ? [] : [`Budget: ${deps.storage.budgets.limit(run.id)} USD`]),
							reused
								? `Reused existing run ${run.id} (${run.state}): identical PRD already active. Use --new to force a new run.`
								: `Created run ${run.id} (${run.state}); target ${run.targetPath} (${run.targetKind})`,
							...(run.targetKind === "git_repo"
								? [
										"Existing repository: discovery of its code arrives in H3; H2 does not touch it.",
									]
								: []),
						]),
					);
				}),
		);

	program
		.command("status")
		.description("Show a run's state, task counts and recent events")
		.argument("<runId>")
		.option("--json", "machine-readable output")
		.action((runId: string, opts: { json?: boolean }) =>
			withRuntime(({ deps }) => {
				handle(getRunStatus(deps, { runId, eventLimit: EVENT_LIMIT }), (status) =>
					print(opts.json === true, status, () => {
						const counts = Object.entries(status.taskCounts)
							.filter(([, n]) => n > 0)
							.map(([state, n]) => `${state}=${n}`)
							.join(" ");
						return [
							`Run ${status.run.id}  state=${status.run.state}  version=${status.run.version}`,
							`Input sha256=${status.run.inputHash}`,
							`Provider mode: ${status.run.providerMode ?? "none yet"}`,
							`Delivery: ${status.delivery.target ?? "undeclared"}, ${status.delivery.status}${status.delivery.cause === null ? "" : ` (${status.delivery.cause})`}${status.delivery.mainCommit === null ? "" : `; main ${status.delivery.mainCommit}`}${status.delivery.reportPath === null ? "" : `; report ${status.delivery.reportPath}`}`,
							`Spec: ${status.planning.specVersion === null ? "none" : `v${status.planning.specVersion}`}  requirements=${status.planning.requirements}  assumptions=${status.planning.assumptions}  contradictions=${status.planning.contradictions} (critical=${status.planning.criticalContradictions})`,
							`Preset: ${status.planning.presets.join(", ") || "none"}`,
							`Tasks: ${counts || "none"}`,
							`Budget: ${status.budget.budgetUsd} USD; charged reported ${status.budget.chargedReportedUsd}, charged unknown ${status.budget.chargedUnknownUsd}, reserved ${status.budget.reservedUsd}, remaining ${status.budget.remainingUsd}`,
							`Provider calls: ${
								Object.entries(status.budget.callsByRole)
									.map(([role, n]) => `${role}=${n}`)
									.join(" ") || "none"
							}; retries=${status.budget.retries}`,
							...(status.quotaWait === null
								? []
								: [
										`Quota wait: ${status.quotaWait.waitUntil === null ? "reset time unknown" : `until ${new Date(status.quotaWait.waitUntil).toISOString()}`}`,
									]),
							...status.planning.blockedTasks.map(
								(t) =>
									`  blocked ${t.key}: ${t.reason}${t.blockedDiff === undefined ? "" : ` (diff: ${t.blockedDiff})`}`,
							),
							...status.planning.reviews.map(
								(r) =>
									`  reviews ${r.key}: ${r.reviews.map((x) => `${x.area}=${x.verdict}`).join(" ")}; open critical/high=${r.openSevere} refuted=${r.refuted} minor=${r.minor} accepted_open=${r.acceptedOpen}${r.ui === undefined ? "" : `; ui evidence=${r.ui.dir} pages=${r.ui.pages} axe_violations=${r.ui.axeViolations} overflow_pages=${r.ui.overflowPages}`}`,
							),
							...(status.dependencyAudit.entries.length === 0
								? []
								: [
										`Dependency audit: ${status.dependencyAudit.entries.at(-1)?.status ?? "none"}; new high/critical=${status.dependencyAudit.blockingNew}; unavailable=${status.dependencyAudit.unavailable}`,
									]),
							"Recent events:",
							...status.recentEvents.map(
								(e) => `  #${e.seq} ${e.type}${e.taskId ? ` (${e.taskId})` : ""}`,
							),
							`Next: ${status.nextStep}`,
						];
					}),
				);
			}),
		);

	program
		.command("plan")
		.description("Drive a run from CREATED to PLANNING with the task graph seeded (resumable)")
		.argument("<runId>")
		.option("--force", "continue even before the provider quota wait has elapsed")
		.option("--json", "machine-readable output")
		.action((runId: string, opts: { json?: boolean; force?: boolean }) =>
			withRuntime(async (runtime) => {
				const planDeps = runtime.planDeps();
				if (!planDeps.ok) return reportFailure(planDeps.error);
				if (config.provider.kind === "fake") {
					io.error(
						`WARNING: FAKE provider enabled (fixtures: ${config.provider.fixturesDir}); output is scripted, not produced by a model`,
					);
				}
				const result = await planRun(planDeps.value, { runId, force: opts.force === true });
				handle(result, (summary) => {
					print(opts.json === true, { ...summary, provider: config.provider.kind }, () => [
						summary.alreadyPlanned
							? `Run ${summary.runId} already planned (${summary.state}); no provider calls`
							: `Planned run ${summary.runId} (${summary.state}): ran ${summary.ran.join(", ") || "none"}; skipped ${summary.skipped.join(", ") || "none"}`,
						`Provider calls: ${summary.providerCalls}; tasks: ${summary.taskCount} (${summary.blockedTaskCount} blocked)`,
						...summary.roleWarnings.map((warning) => `WARNING: ${warning}`),
						...(summary.state === "BLOCKED"
							? ["Run is BLOCKED; see `factory status` for the cause."]
							: []),
					]);
					if (summary.state === "BLOCKED") exitCode = EXIT_FAILURE;
				});
			}),
		);

	program
		.command("build")
		.description(
			"Build a planned run task by task (red, green, integration); --bootstrap-only only scaffolds the product and runs its checks",
		)
		.argument("<runId>")
		.option(
			"--bootstrap-only",
			"scaffold the product skeleton and run npm ci + npm run check, without building tasks",
		)
		.option("--force", "continue even before the provider quota wait has elapsed")
		.option("--max-tasks <n>", "stop after this many tasks", parsePositive)
		.option(
			"--max-provider-calls <n>",
			`stop before exceeding this many builder calls (default ${DEFAULT_MAX_PROVIDER_CALLS})`,
			parsePositive,
		)
		.option("--json", "machine-readable output")
		.action(
			(
				runId: string,
				opts: {
					json?: boolean;
					force?: boolean;
					bootstrapOnly?: boolean;
					maxTasks?: number;
					maxProviderCalls?: number;
				},
			) =>
				withRuntime(async (runtime) => {
					const prepared = await runtime.buildDeps(runId);
					if (!prepared.ok) return reportFailure(prepared.error);
					if (prepared.value.warning !== null) io.error(`WARNING: ${prepared.value.warning}`);
					const runner = prepared.value.deps.runner;
					if (opts.bootstrapOnly !== true) {
						if (config.provider.kind === "fake") {
							io.error(
								`WARNING: FAKE provider enabled (fixtures: ${config.provider.fixturesDir}); builder output is scripted, not produced by a model`,
							);
						}
						const built = await buildRun(prepared.value.deps, {
							runId,
							repairsPerTask: config.repairsPerTask,
							force: opts.force === true,
							...(opts.maxTasks === undefined ? {} : { maxTasks: opts.maxTasks }),
							...(opts.maxProviderCalls === undefined
								? {}
								: { maxProviderCalls: opts.maxProviderCalls }),
						});
						handle(built, (summary) => {
							print(
								opts.json === true,
								{
									runner: runner.kind,
									isolated: runner.isolated,
									provider: config.provider.kind,
									...summary,
								},
								() => [
									`Runner: ${runner.kind}${runner.isolated ? " (isolated)" : " (NO ISOLATION)"}`,
									...summary.tasks.map(
										(t) =>
											`${t.outcome.toUpperCase().padEnd(8)} ${t.key}${t.reason === null ? "" : ` (${t.reason})`}`,
									),
									...summary.blockedTasks.map((t) => `  blocked ${t.key}: ${t.reason}`),
									...(summary.reviewTasks.length > 0
										? [`Requires review: ${summary.reviewTasks.join(", ")}`]
										: []),
									`Provider calls: ${summary.providerCalls}; stopped because: ${summary.stoppedBecause}${summary.stopDetail === null ? "" : ` (${summary.stopDetail})`}`,
									`Run state: ${summary.runState}`,
									summary.passed
										? "All tasks DONE and the final integration check passed."
										: "Build not complete; nothing was marked as passed without a green check on the integration commit.",
								],
							);
							if (summary.blockedTasks.length > 0 || OPERATOR_STOPS.has(summary.stoppedBecause)) {
								exitCode = EXIT_FAILURE;
							}
						});
						return;
					}
					const result = await buildBootstrapOnly(prepared.value.deps, { runId });
					handle(result, (summary) => {
						print(
							opts.json === true,
							{ runId, runner: runner.kind, isolated: runner.isolated, ...summary },
							() => [
								`Bootstrap: template ${summary.bootstrap.templateId}, commit ${summary.bootstrap.commitSha}${summary.bootstrap.skipped ? " (already bootstrapped, skipped)" : ""}`,
								`Runner: ${runner.kind}${runner.isolated ? " (isolated)" : " (NO ISOLATION)"}`,
								...summary.checks.map(
									(c) =>
										`${c.exitCode === 0 ? "OK  " : "FAIL"} ${c.argv.join(" ")} exit=${c.exitCode} ${(c.durationMs / 1000).toFixed(1)}s log=${c.logPath}`,
								),
								...(runner.isolated && summary.checks.some((c) => c.exitCode === 125)
									? [
											"Hint: exit 125 means docker could not start the container. On Docker Desktop only paths under your home directory are shared with its VM; use a --target under it.",
										]
									: []),
								summary.passed
									? "All product checks passed."
									: "Product checks FAILED; nothing was marked as passed.",
							],
						);
						if (!summary.passed) exitCode = EXIT_FAILURE;
					});
				}),
		);

	program
		.command("resume")
		.description("Reconcile leases and ready tasks of a run")
		.argument("<runId>")
		.option("--force", "continue even before the provider quota wait has elapsed")
		.action((runId: string, opts: { force?: boolean }) =>
			withRuntime(({ deps }) => {
				handle(resumeRun(deps, { runId, force: opts.force === true }), (summary) =>
					io.out(
						`Resumed ${runId}: ${summary.expiredTaskIds.length} expired lease(s) recovered, ${summary.readiedTaskIds.length} task(s) ready`,
					),
				);
			}),
		);

	program
		.command("retry")
		.description(
			"Re-queue a BLOCKED task with a retryable reason (at most FACTORY_MAX_TASK_RETRIES times) and optional operator guidance for the builder",
		)
		.argument("<runId>")
		.argument("<taskKey>")
		.option("--note <text>", "operator guidance passed to the builder (trusted input)")
		.option("--force", "operator override for a non-retryable reason, recorded in the history")
		.option("--json", "machine-readable output")
		.action(
			(runId: string, taskKey: string, opts: { note?: string; json?: boolean; force?: boolean }) =>
				withRuntime(({ deps }) => {
					handle(
						retryTask(deps, {
							runId,
							taskKey,
							maxRetries: config.maxTaskRetries,
							force: opts.force === true,
							...(opts.note === undefined ? {} : { note: opts.note }),
						}),
						(summary) =>
							print(opts.json === true, { runId, ...summary }, () => [
								`Task ${summary.key} is READY again (retry ${summary.retries}; was blocked by ${summary.reason}). Run \`factory build ${runId}\` to continue.`,
							]),
					);
				}),
		);

	program
		.command("budget")
		.description(
			"Add budget to a run; a run BLOCKED by budget_exhausted or quota_wait returns to its prior state",
		)
		.argument("<runId>")
		.requiredOption("--add <usd>", "USD to add to the run budget", parsePositiveUsd)
		.option("--json", "machine-readable output")
		.action((runId: string, opts: { add: number; json?: boolean }) =>
			withRuntime(({ deps }) => {
				handle(addBudget(deps, { runId, addUsd: opts.add }), (result) =>
					print(opts.json === true, { runId, ...result }, () => [
						`Budget of ${runId} is now ${result.budgetUsd} USD (run ${result.state}${result.unblocked ? ", unblocked" : ""}).`,
						...(result.unblocked
							? [`Run \`factory build ${runId}\` (or \`factory plan ${runId}\`) to continue.`]
							: []),
					]),
				);
			}),
		);

	program
		.command("cancel")
		.description("Cancel a run and its non-terminal tasks")
		.argument("<runId>")
		.action((runId: string) =>
			withRuntime(({ deps }) => {
				handle(cancelRun(deps, { runId }), ({ canceledTaskIds }) =>
					io.out(`Canceled ${runId}; ${canceledTaskIds.length} task(s) canceled`),
				);
			}),
		);

	program
		.command("report")
		.description("Traceability report of a run (requirement to evidence), built from the database")
		.argument("<runId>")
		.option("--json", "machine-readable output")
		.action((runId: string, opts: { json?: boolean }) =>
			withRuntime(({ deps }) => {
				handle(
					buildRunReport({ storage: deps.storage, factoryHome: config.factoryHome }, runId),
					(report) =>
						io.out(
							(opts.json === true
								? renderReportJson(report)
								: renderReportMarkdown(report)
							).trimEnd(),
						),
				);
			}),
		);

	program
		.command("deliver")
		.description(
			"Write the report into the product, merge integration into main and finish the run with delivery local (needs READY_FOR_RELEASE)",
		)
		.argument("<runId>")
		.option("--json", "machine-readable output")
		.action((runId: string, opts: { json?: boolean }) =>
			withRuntime(async (runtime) => {
				const prepared = await runtime.buildDeps(runId);
				if (!prepared.ok) return reportFailure(prepared.error);
				if (prepared.value.warning !== null) io.error(`WARNING: ${prepared.value.warning}`);
				const delivered = await deliverRun(prepared.value.deps, { runId });
				handle(delivered, (summary) =>
					print(opts.json === true, summary, () => [
						summary.alreadyDelivered
							? `Run ${runId} was already delivered; nothing changed.`
							: `Delivered run ${runId} locally.`,
						`Product: ${summary.targetPath} (branch main, merge commit ${summary.mainCommit}; report commit ${summary.reportCommit})`,
						`Report: ${summary.targetPath}/${summary.reportPath} (+ ${summary.reportJsonPath}); also \`factory report ${runId}\``,
						`Runbook: ${summary.targetPath}/${summary.runbookPath} (production publishing stays disabled)`,
						`Run it: cd ${summary.targetPath} && npm ci && npm run check (see README.md in the product for how to start it)`,
						`View the report: less ${summary.targetPath}/${summary.reportPath}`,
						...(summary.remotes.length === 0
							? ["No git remote is configured: nothing was pushed and no pull request exists."]
							: [
									`The product has remote(s): ${summary.remotes.join(", ")}. Nothing was pushed. To publish, you could run:`,
									...summary.remotes.map(
										(remote) => `  git -C ${summary.targetPath} push ${remote} main`,
									),
								]),
					]),
				);
			}),
		);

	program
		.command("run")
		.description(
			"One command: start (deduplicated), plan, build and deliver a PRD; re-run the same command to resume",
		)
		.requiredOption("--prd <path>", "path to the PRD file")
		.requiredOption("--target <dir>", "directory where the product will be built")
		.option("--project <name>", "project name (defaults to the current directory name)")
		.option("--budget-usd <n>", "run budget in USD when the run is created", parsePositiveUsd)
		.option(
			"--max-provider-calls <n>",
			"stop a build pass after this many builder calls",
			parsePositive,
		)
		.option("--max-tasks <n>", "stop a build pass after this many tasks", parsePositive)
		.option("--force", "continue even before the provider quota wait has elapsed")
		.option("--json", "machine-readable output")
		.action(
			(opts: {
				prd: string;
				target: string;
				project?: string;
				budgetUsd?: number;
				maxProviderCalls?: number;
				maxTasks?: number;
				force?: boolean;
				json?: boolean;
			}) =>
				withRuntime(async (runtime) => {
					if (config.provider.kind === "fake") {
						io.error(
							`WARNING: FAKE provider enabled (fixtures: ${config.provider.fixturesDir}); output is scripted, not produced by a model`,
						);
					}
					let warned = false;
					const result = await runAll(
						{
							start: runtime.deps,
							prepare: async (runId) => {
								const prepared = await runtime.buildDeps(runId);
								if (!prepared.ok) return prepared;
								if (prepared.value.warning !== null && !warned) {
									warned = true;
									io.error(`WARNING: ${prepared.value.warning}`);
								}
								return ok(prepared.value.deps);
							},
						},
						{
							prdPath: opts.prd,
							targetPath: opts.target,
							cwd: process.cwd(),
							repairsPerTask: config.repairsPerTask,
							...(opts.project === undefined ? {} : { projectName: opts.project }),
							...(opts.budgetUsd === undefined ? {} : { budgetUsd: opts.budgetUsd }),
							...(opts.maxProviderCalls === undefined
								? {}
								: { maxProviderCalls: opts.maxProviderCalls }),
							...(opts.maxTasks === undefined ? {} : { maxTasks: opts.maxTasks }),
							force: opts.force === true,
						},
					);
					handle(result, (outcome) => {
						print(opts.json === true, { ...outcome, provider: config.provider.kind }, () => [
							`Run ${outcome.runId} (${outcome.reused ? "resumed" : "new"}): ${outcome.result}, state ${outcome.state}; phases this pass: ${outcome.phases.join(", ") || "none"}; provider calls: ${outcome.providerCalls}`,
							outcome.message,
							...(outcome.delivery === null
								? []
								: [
										`Product: ${outcome.delivery.targetPath} (main ${outcome.delivery.mainCommit}); report: ${outcome.delivery.targetPath}/${outcome.delivery.reportPath}`,
									]),
							...(outcome.nextCommand === null ? [] : [`Next: ${outcome.nextCommand}`]),
						]);
						exitCode = RUN_EXIT[outcome.result];
					});
				}),
		);

	program
		.command("audit")
		.description(
			"Read-only audit of an existing repository: checks on a snapshot of HEAD, optional model reviewers, before/after state comparison",
		)
		.requiredOption("--target <repo>", "path of the git repository to audit")
		.option(
			"--review",
			"also run the security and code reviewers read-only (counts against a budget)",
		)
		.option("--budget-usd <n>", "budget of the audit pseudo-run in USD", parsePositiveUsd)
		.option("--json", "machine-readable output")
		.action((opts: { target: string; review?: boolean; budgetUsd?: number; json?: boolean }) =>
			withRuntime(async (runtime) => {
				const target = resolve(opts.target);
				const prepared = await runtime.auditDeps(target);
				if (!prepared.ok) return reportFailure(prepared.error);
				if (prepared.value.warning !== null) io.error(`WARNING: ${prepared.value.warning}`);
				const audited = await auditRepo(prepared.value.deps, {
					target,
					review: opts.review === true,
					...(opts.budgetUsd === undefined ? {} : { budgetUsd: opts.budgetUsd }),
				});
				handle(audited, (report) => {
					print(opts.json === true, report, () => [
						`Audit ${report.auditId}: ${report.result}; HEAD ${report.headSha}; checks ${report.checkMode}${report.skipReason === null ? "" : ` (skipped: ${report.skipReason})`}`,
						...report.checks.map(
							(c) =>
								`  ${c.exitCode === 0 ? "OK  " : "FAIL"} ${c.argv.join(" ")} exit=${c.exitCode}`,
						),
						...(report.reviews ?? []).map(
							(r) => `  review ${r.area}: ${r.verdict}, ${r.findings.length} finding(s)`,
						),
						`Report: ${config.factoryHome}/audits/${report.auditId}/report.md`,
					]);
					if (report.result === "target_mutated") {
						io.error(
							`error [target_mutated]: the audited repository changed during the audit: ${report.diff.files.map((f) => `${f.change} ${f.path}`).join(", ") || "HEAD or git status"}`,
						);
						exitCode = EXIT_FAILURE;
					} else if (report.result === "checks_failed") {
						exitCode = EXIT_FAILURE;
					}
				});
			}),
		);

	const release = program
		.command("release")
		.description("Release preparation (publishing is disabled by policy)");
	release
		.command("prepare")
		.description(
			"Write the release plan (and the runbook text) for a run; deliver commits the runbook into the product",
		)
		.argument("<runId>")
		.option("--json", "machine-readable output")
		.action((runId: string, opts: { json?: boolean }) =>
			withRuntime((runtime) => {
				handle(prepareRelease(runtime.releaseDeps(), { runId }), (prepared) =>
					print(opts.json === true, prepared, () => [
						`Release plan for ${runId}: ${config.factoryHome}/runs/${runId}/${prepared.planArtifactPath} (publishing ${prepared.plan.publishingEnabled ? "enabled" : "DISABLED by policy"})`,
						`Runbook: ${prepared.runbookPath} is committed into the product by \`factory deliver ${runId}\`.`,
					]),
				);
			}),
		);

	try {
		await program.parseAsync(argv, { from: "user" });
	} catch (cause) {
		if (cause instanceof CommanderError) {
			return cause.exitCode === 0 ? EXIT_OK : EXIT_USAGE;
		}
		throw cause;
	}
	return exitCode;
};
