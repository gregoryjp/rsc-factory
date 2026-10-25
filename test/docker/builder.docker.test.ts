import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isCheckEvidenceValid } from "../../src/domain/checks/evidence.js";
import { toProductSlug } from "../../src/domain/templates/render.js";
import { deliverRun } from "../../src/modules/delivery/deliver-run.js";
import { buildRun } from "../../src/modules/execution/build-run.js";
import {
	approverSays,
	completed,
	createBuildEnv,
	findingsReview,
	passReview,
	refuterOutcomes,
	reviewFinding,
	task,
} from "../helpers/build-env.js";
import { FULLSTACK } from "../helpers/exec-env.js";
import {
	dockerAvailable,
	labeled,
	makeDockerRunner,
	makeHomeTempDir,
	SKIP_REASON,
} from "./docker-helpers.js";

const MINUTES = 60_000;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const PING_TEST = `import { describe, expect, it } from "vitest";
import { buildProduct } from "../../../composition.js";

describe("ping", () => {
	it("GET /api/v1/ping is mounted behind authentication", () => {
		const route = buildProduct().routes.find(
			(r) => r.method === "GET" && r.path === "/api/v1/ping",
		);
		expect(route?.access).toBe("protected");
	});
});
`;

const COMPOSITION_PATH = join(
	import.meta.dirname,
	"../../factory/templates/apiweb/api/src/composition.ts",
);

const composeWithPing = (): string => {
	const base = readFileSync(COMPOSITION_PATH, "utf8");
	const anchor = 'import { createHealthModule } from "./modules/health/index.js";\n';
	const mounts = "...(overrides.extraProtectedMounts ?? []),";
	return base
		.replace(anchor, `${anchor}import { createPingModule } from "./modules/ping/index.js";\n`)
		.replace(mounts, `{ path: "/ping", router: createPingModule() },\n\t\t\t${mounts}`);
};

const PING_GREEN = {
	"api/src/modules/ping/services/ping.service.ts": `export type PingStatus = { pong: true };

export type PingService = { ping: () => PingStatus };

export const createPingService = (): PingService => ({ ping: () => ({ pong: true }) });
`,
	"api/src/modules/ping/controllers/ping.controller.ts": `import type { RequestHandler } from "express";
import { sendData } from "../../../infrastructure/http/respond.js";
import type { PingService } from "../services/ping.service.js";

export type PingController = { ping: RequestHandler };

export const createPingController = (service: PingService): PingController => ({
	ping: (_req, res) => {
		sendData(res, service.ping());
	},
});
`,
	"api/src/modules/ping/routes/ping.routes.ts": `import { Router } from "express";
import type { PingController } from "../controllers/ping.controller.js";

export const createPingRoutes = (controller: PingController): Router =>
	Router().get("/", controller.ping);
`,
	"api/src/modules/ping/index.ts": `import type { Router } from "express";
import { createPingController } from "./controllers/ping.controller.js";
import { createPingRoutes } from "./routes/ping.routes.js";
import { createPingService } from "./services/ping.service.js";

export const createPingModule = (): Router =>
	createPingRoutes(createPingController(createPingService()));
`,
	"api/src/composition.ts": composeWithPing(),
};

describe.skipIf(!dockerAvailable)(
	`builder loop acceptance (${dockerAvailable ? "real Docker" : SKIP_REASON})`,
	() => {
		it(
			"one task on the apiweb skeleton goes red, green and integrated with Postgres in Docker",
			async () => {
				const home = makeHomeTempDir();
				const ping = {
					...task("ping"),
					title: "Ping endpoint",
					expectedPaths: ["api/src/modules/ping/"],
				};
				const env = await createBuildEnv({
					tasks: [ping],
					builder: [
						completed({
							writes: { "api/src/modules/ping/__tests__/ping.e2e.test.ts": PING_TEST },
						}),
						completed({ writes: PING_GREEN }),
						completed({
							writes: {
								"api/src/modules/ping/services/ping.service.ts": `${PING_GREEN["api/src/modules/ping/services/ping.service.ts"]}\nexport const PING_PATH = "/ping";\n`,
							},
						}),
					],
					reviewers: {
						security: [
							findingsReview("security", [
								reviewFinding({
									title: "Ping route lacks an explicit contract constant",
									file: "api/src/modules/ping/services/ping.service.ts",
								}),
							]),
							passReview("security"),
						],
						code: [passReview("code"), passReview("code")],
						refuter: [refuterOutcomes([{ id: "F1", outcome: "confirmed" }])],
						approver: [
							approverSays("repair", [
								{ findingIds: ["F1"], instruction: "export the route path constant" },
							]),
							approverSays("accept"),
						],
					},
					template: {
						home,
						target: join(makeHomeTempDir(), "product"),
						presetIds: FULLSTACK,
						projectName: "turno-local",
						runner: makeDockerRunner(home, toProductSlug("turno-local")),
					},
				});
				const result = await buildRun(env.deps, { runId: env.runId });
				if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
				const summary = result.value;
				const checks = env.storage.checks.listByRun(env.runId);
				const log = (id: string | undefined) => {
					const check = checks.find((c) => c.id === id);
					return check ? readFileSync(join(home, check.logPath), "utf8").replace(ANSI, "") : "";
				};
				const failureContext = checks.map((c) => `${c.argv.join(" ")} -> ${c.exitCode}`).join("\n");
				expect(summary.tasks, failureContext).toEqual([
					expect.objectContaining({ key: "ping", outcome: "done" }),
				]);
				expect(summary.runState).toBe("READY_FOR_RELEASE");
				expect(summary.providerCalls).toBe(10);
				const taskHead = env.git.headSha(env.target);
				expect(taskHead.ok).toBe(true);
				const reviews = env.storage.reviews.listReviews(env.taskIds.ping ?? "", 0);
				expect(new Set(reviews.map((r) => r.commitSha)).size).toBe(2);
				expect(env.buildOf("ping")).toMatchObject({ repairs: 1, phase: "done" });

				const taskChecks = checks.filter((c) => c.taskId === env.taskIds.ping);
				const test = taskChecks.filter((c) => c.argv.join(" ").startsWith("npm run test"));
				expect(test[0]?.exitCode).not.toBe(0);
				expect(log(test[0]?.id)).toContain("ping.e2e.test.ts");
				const integrationHead = env.git.headSha(env.target);
				if (!integrationHead.ok) throw new Error(integrationHead.error.message);
				const integrationCheck = checks.find(
					(c) => c.cwd === "integration" && c.argv.join(" ") === "npm run check",
				);
				expect(integrationCheck?.exitCode).toBe(0);
				expect(
					integrationCheck && isCheckEvidenceValid(integrationCheck, integrationHead.value),
				).toBe(true);
				expect(log(integrationCheck?.id)).toContain("ping.e2e.test.ts");
				expect(env.taskOf("ping").state).toBe("DONE");

				const delivered = await deliverRun(env.deps, { runId: env.runId });
				if (!delivered.ok) throw new Error(`${delivered.error.code}: ${delivered.error.message}`);
				expect(env.storage.runs.get(env.runId)).toMatchObject({
					state: "SUCCEEDED",
					deliveryTarget: "local",
				});
				const afterDelivery = env.storage.checks.listByRun(env.runId);
				const mainHead = env.git.headSha(env.target);
				if (!mainHead.ok) throw new Error(mainHead.error.message);
				expect(mainHead.value).toBe(delivered.value.mainCommit);
				const deliveryChecks = afterDelivery.filter((c) => c.cwd.startsWith("delivery-"));
				expect(
					deliveryChecks.map((c) => [c.cwd, c.argv.join(" "), c.exitCode, c.isolated]),
					deliveryChecks.map((c) => log(c.id).slice(-1500)).join("\n"),
				).toEqual([
					["delivery-audit", "npm audit --omit=dev --json", 1, true],
					["delivery-report", "npm ci", 0, true],
					["delivery-report", "npm run check", 0, true],
					["delivery-main", "npm ci", 0, true],
					["delivery-main", "npm run check", 0, true],
				]);
				expect(deliveryChecks.at(-1)?.commitSha).toBe(mainHead.value);
				const report = env.git.showFile(env.target, "main", "docs/verification/factory-report.md");
				expect(report.ok && report.value).toContain("aislado (Docker)");
				expect(report.ok && report.value).toContain("Proveedor: FALSO");
				expect(env.git.isClean(env.target)).toEqual({ ok: true, value: true });
				expect(labeled("ps", env.runId)).toEqual([]);
				expect(labeled("network", env.runId)).toEqual([]);
			},
			30 * MINUTES,
		);
	},
);
