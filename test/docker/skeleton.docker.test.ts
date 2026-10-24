import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toProductSlug } from "../../src/domain/templates/render.js";
import { buildBootstrapOnly } from "../../src/modules/execution/build-run.js";
import { commitAll, createExecEnv, FULLSTACK, seedPlanningRun } from "../helpers/exec-env.js";
import {
	dockerAvailable,
	labeled,
	makeDockerRunner,
	makeHomeTempDir,
	SKIP_REASON,
} from "./docker-helpers.js";

const MINUTES = 60_000;

const setup = (presetIds: string[], slug: string) => {
	const home = makeHomeTempDir();
	const exec = createExecEnv(home);
	const runner = makeDockerRunner(home, toProductSlug(slug));
	const { runId, target } = seedPlanningRun(exec.env, {
		presetIds,
		target: join(makeHomeTempDir(), "product"),
		projectName: slug,
	});
	return { ...exec, home, runId, target, deps: { ...exec.deps, runner } };
};

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const logOf = (home: string, relativeLog: string): string =>
	readFileSync(join(home, relativeLog), "utf8").replace(ANSI, "");

describe.skipIf(!dockerAvailable)(
	`skeleton acceptance (${dockerAvailable ? "real Docker" : SKIP_REASON})`,
	() => {
		const fullstack = dockerAvailable ? setup(FULLSTACK, "turno-local") : undefined;

		it(
			"apiweb passes npm ci and npm run check in Docker against a real Postgres",
			async () => {
				if (!fullstack) return;
				const built = await buildBootstrapOnly(fullstack.deps, { runId: fullstack.runId });
				if (!built.ok) throw new Error(`${built.error.code}: ${built.error.message}`);
				const summary = built.value;
				const logs = summary.checks.map((c) => logOf(fullstack.home, c.logPath));
				expect(
					summary.checks.map((c) => [c.argv.join(" "), c.exitCode, c.isolated]),
					logs.at(-1)?.slice(-4000),
				).toEqual([
					["npm ci", 0, true],
					["npm run check", 0, true],
				]);
				expect(summary.passed).toBe(true);
				const checkLog = logs[1] ?? "";
				expect(checkLog).toContain("health.e2e.test.ts");
				expect(checkLog).toMatch(/Tests\s+\d+ passed/);
				expect(checkLog).toContain("Module boundaries OK");
				expect(checkLog).toContain("Layers OK");
				expect(labeled("ps", fullstack.runId)).toEqual([]);
				expect(labeled("network", fullstack.runId)).toEqual([]);
			},
			30 * MINUTES,
		);

		it(
			"E05 at bootstrap level: an injected failing test makes npm run check fail and the build report failure",
			async () => {
				if (!fullstack) return;
				writeFileSync(
					join(fullstack.target, "api/src/modules/health/__tests__/injected.test.ts"),
					'import { expect, it } from "vitest";\n\nit("injected failure", () => {\n\texpect(1).toBe(2);\n});\n',
				);
				const committed = commitAll(fullstack.git, fullstack.target, "test: inject a failing test");
				expect(committed.ok).toBe(true);
				const built = await buildBootstrapOnly(fullstack.deps, { runId: fullstack.runId });
				if (!built.ok) throw new Error(`${built.error.code}: ${built.error.message}`);
				const last = built.value.checks.at(-1);
				expect(built.value.passed).toBe(false);
				expect(last?.argv).toEqual(["npm", "run", "check"]);
				expect(last?.exitCode).not.toBe(0);
				expect(logOf(fullstack.home, last?.logPath ?? "")).toContain("injected failure");
				expect(fullstack.env.storage.runs.get(fullstack.runId)?.state).toBe("PLANNING");
			},
			30 * MINUTES,
		);

		it(
			"api passes npm ci and npm run check in Docker against a real Postgres, without any web workspace",
			async () => {
				const apiRun = setup(["backend-express-kimmbo"], "api-demo");
				const built = await buildBootstrapOnly(apiRun.deps, { runId: apiRun.runId });
				if (!built.ok) throw new Error(`${built.error.code}: ${built.error.message}`);
				const logs = built.value.checks.map((c) => logOf(apiRun.home, c.logPath));
				expect(
					built.value.checks.map((c) => [c.argv.join(" "), c.exitCode, c.isolated]),
					logs.at(-1)?.slice(-4000),
				).toEqual([
					["npm ci", 0, true],
					["npm run check", 0, true],
				]);
				expect(built.value.passed).toBe(true);
				expect(logs[1] ?? "").toContain("health.e2e.test.ts");
				expect(existsSync(join(apiRun.target, "web"))).toBe(false);
				expect(labeled("ps", apiRun.runId)).toEqual([]);
			},
			30 * MINUTES,
		);

		it(
			"static-landing passes npm ci and npm run check in Docker",
			async () => {
				const staticRun = setup(["static-landing"], "landing-demo");
				const built = await buildBootstrapOnly(staticRun.deps, { runId: staticRun.runId });
				if (!built.ok) throw new Error(`${built.error.code}: ${built.error.message}`);
				expect(built.value.checks.map((c) => [c.argv.join(" "), c.exitCode, c.isolated])).toEqual([
					["npm ci", 0, true],
					["npm run check", 0, true],
				]);
				expect(built.value.passed).toBe(true);
				expect(logOf(staticRun.home, built.value.checks[1]?.logPath ?? "")).toContain(
					"Static landing check OK",
				);
				expect(labeled("ps", staticRun.runId)).toEqual([]);
			},
			30 * MINUTES,
		);

		it(
			"mobile passes npm ci and npm run check in Docker",
			async () => {
				const mobileRun = setup(["mobile-expo"], "mobile-demo");
				const started = Date.now();
				const built = await buildBootstrapOnly(mobileRun.deps, { runId: mobileRun.runId });
				if (!built.ok) throw new Error(`${built.error.code}: ${built.error.message}`);
				console.info(`mobile skeleton took ${Math.round((Date.now() - started) / 1000)}s`);
				const logs = built.value.checks.map((c) => logOf(mobileRun.home, c.logPath));
				expect(
					built.value.checks.map((c) => [c.argv.join(" "), c.exitCode, c.isolated]),
					logs.at(-1)?.slice(-4000),
				).toEqual([
					["npm ci", 0, true],
					["npm run check", 0, true],
				]);
				expect(built.value.passed).toBe(true);
				expect(logs[1] ?? "").toContain("greeting.test.ts");
				expect(labeled("ps", mobileRun.runId)).toEqual([]);
			},
			30 * MINUTES,
		);
	},
);
