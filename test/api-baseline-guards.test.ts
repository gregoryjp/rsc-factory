import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir, REPO_ROOT } from "./helpers/env.js";

const TEMPLATES = join(REPO_ROOT, "factory", "templates");
const TEMPLATE_IDS = ["api", "apiweb"] as const;

const run = (template: string, script: string, root: string) => {
	const result = spawnSync(
		process.execPath,
		[join(TEMPLATES, template, "api", "scripts", script), "--root", root],
		{ encoding: "utf8" },
	);
	return { code: result.status, out: `${result.stdout}${result.stderr}` };
};

const tree = (files: Record<string, string>): string => {
	const root = makeTempDir();
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return root;
};

describe("api guard: check-pagination", () => {
	it("rejects findMany without take in a module", () => {
		const root = tree({
			"src/modules/a/repositories/a.repository.ts":
				"export const list = (prisma: P) => prisma.thing.findMany({ where: { a: 1 } });\n",
			"src/modules/b/repositories/b.repository.ts":
				"export const list = (prisma: P) =>\n\tprisma.thing.findMany({\n\t\twhere: { a: 1 },\n\t\torderBy: { id: 'asc' },\n\t});\n",
		});
		const result = run("api", "check-pagination.mjs", root);
		expect(result.code).toBe(1);
		expect(result.out).toContain("a.repository.ts:1");
		expect(result.out).toContain("b.repository.ts:2");
	});

	it("accepts bounded queries, unrelated take words outside the call and tests", () => {
		const root = tree({
			"src/modules/a/repositories/a.repository.ts":
				"export const list = (prisma: P, w: { take: number }) =>\n\tprisma.thing.findMany({ where: { a: 1 }, take: w.take });\n",
			"src/modules/a/__tests__/a.test.ts": "await prisma.thing.findMany();\n",
		});
		expect(run("api", "check-pagination.mjs", root).code).toBe(0);
	});

	it("fails closed when the modules directory is missing", () => {
		expect(run("api", "check-pagination.mjs", makeTempDir()).code).toBe(1);
	});
});

const shipped = (template: string, path: string): string =>
	readFileSync(join(TEMPLATES, template, path), "utf8");

const deployTree = (template: string, mutate: (files: Record<string, string>) => void): string => {
	const files: Record<string, string> = {
		Dockerfile: shipped(template, "Dockerfile"),
		".dockerignore": shipped(template, ".dockerignore"),
		"docker-compose.prod.example.yml": shipped(template, "docker-compose.prod.example.yml"),
		".github/workflows/ci.yml": shipped(template, ".github/workflows/ci.yml"),
	};
	mutate(files);
	const product = makeTempDir();
	mkdirSync(join(product, "api"), { recursive: true });
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(product, path)), { recursive: true });
		writeFileSync(join(product, path), content);
	}
	return join(product, "api");
};

describe("api guard: check-deploy", () => {
	for (const template of TEMPLATE_IDS) {
		it(`passes the shipped ${template} deployment files`, () => {
			const root = deployTree(template, () => {});
			const result = run(template, "check-deploy.mjs", root);
			expect(result.code, result.out).toBe(0);
		});
	}

	const bad = (mutate: (files: Record<string, string>) => void, expected: RegExp) => {
		const result = run("api", "check-deploy.mjs", deployTree("api", mutate));
		expect(result.code, result.out).toBe(1);
		expect(result.out).toMatch(expected);
	};

	it("rejects a final stage that runs as root or without a USER", () => {
		bad((f) => {
			f.Dockerfile = (f.Dockerfile ?? "").replace(/^USER node$/gm, "USER root");
		}, /non-root USER/);
		bad((f) => {
			f.Dockerfile = (f.Dockerfile ?? "").replace(/^USER node$/gm, "USER 0:0");
		}, /non-root USER/);
		bad((f) => {
			f.Dockerfile = (f.Dockerfile ?? "").replace(/^USER node$/gm, "");
		}, /non-root USER/);
	});

	it("rejects an unpinned base image and a missing HEALTHCHECK", () => {
		bad((f) => {
			f.Dockerfile = (f.Dockerfile ?? "").replace(/@sha256:[a-f0-9]{64}/, "");
		}, /pinned by @sha256/);
		bad((f) => {
			f.Dockerfile = (f.Dockerfile ?? "").replace(/^HEALTHCHECK[\s\S]*?\n(?=CMD)/m, "");
		}, /HEALTHCHECK/);
	});

	it("rejects development dependencies reaching the final stage", () => {
		bad((f) => {
			f.Dockerfile = (f.Dockerfile ?? "").replace(
				"COPY --from=prod-deps /app/node_modules ./node_modules",
				"COPY --from=build /app/node_modules ./node_modules",
			);
		}, /dev dependencies/);
		bad((f) => {
			f.Dockerfile = (f.Dockerfile ?? "").replace(
				"npm ci -w api --omit=dev --ignore-scripts",
				"npm ci -w api",
			);
		}, /omit=dev/);
	});

	it("rejects missing .dockerignore entries, writable compose and an incomplete workflow", () => {
		bad((f) => {
			f[".dockerignore"] = "dist\n";
		}, /\.dockerignore must list node_modules/);
		bad((f) => {
			f["docker-compose.prod.example.yml"] = (f["docker-compose.prod.example.yml"] ?? "").replace(
				"read_only: true",
				"read_only: false",
			);
		}, /read_only: true/);
		bad((f) => {
			f[".github/workflows/ci.yml"] = (f[".github/workflows/ci.yml"] ?? "").replace(
				"npm audit --omit=dev",
				"npm audit",
			);
		}, /npm audit --omit=dev/);
	});

	it("fails closed when the Dockerfile is missing", () => {
		bad((f) => {
			delete f.Dockerfile;
		}, /Dockerfile is missing/);
	});
});

describe("api and apiweb share the production baseline", () => {
	it("ship identical scripts, ignore file, compose example, workflow and runbooks", () => {
		for (const path of [
			"scripts/db-backup.sh",
			"scripts/db-restore.sh",
			".dockerignore",
			"docker-compose.prod.example.yml",
			".github/workflows/ci.yml",
			"docs/operations/base-de-datos.md",
			"docs/operations/backup-restore.md",
			"docs/operations/despliegue.md",
		]) {
			expect(shipped("apiweb", path), path).toBe(shipped("api", path));
		}
	});

	it("differ in the Dockerfile only by the web workspace manifest", () => {
		const withoutWeb = shipped("apiweb", "Dockerfile")
			.split("\n")
			.filter((line) => line !== "COPY web/package.json web/package.json")
			.join("\n");
		expect(withoutWeb).toBe(shipped("api", "Dockerfile"));
	});

	it("pin the same node image digest as the factory", () => {
		const compatibility = readFileSync(
			join(REPO_ROOT, "src", "config", "compatibility.ts"),
			"utf8",
		);
		const image = /NODE_IMAGE =\s*"([^"]+)"/.exec(compatibility)?.[1];
		expect(image).toBeDefined();
		for (const template of TEMPLATE_IDS) {
			expect(shipped(template, "Dockerfile")).toContain(`FROM ${image} AS base`);
		}
	});

	it("keeps the compose example and manifest consistent", () => {
		for (const template of TEMPLATE_IDS) {
			const manifest = JSON.parse(shipped(template, "template.json")) as {
				render: string[];
				provides: string[];
			};
			expect(manifest.render).toContain("docker-compose.prod.example.yml");
			for (const entry of manifest.provides) expect(entry.length).toBeLessThanOrEqual(200);
			const compose = shipped(template, "docker-compose.prod.example.yml");
			expect(compose.match(/factory\.managed: "true"/g)?.length).toBe(3);
			expect(compose).not.toMatch(/container_name: (?!factory-)/);
		}
	});
});
