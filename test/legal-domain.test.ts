import { describe, expect, it } from "vitest";
import { ReviewAreaSchema } from "../src/contracts/review.js";
import { LEGAL_NOT_APPLICABLE_REASON, legalApplicability } from "../src/domain/review/legal.js";

const section = (path: string, added: string[]): string =>
	[
		`diff --git a/${path} b/${path}`,
		`--- a/${path}`,
		`+++ b/${path}`,
		"@@ -0,0 +1 @@",
		...added.map((line) => `+${line}`),
	].join("\n");

type Input = {
	changedFiles?: string[];
	diff?: string;
	requirementsText?: string;
	templateId?: string;
};

const run = (over: Input) =>
	legalApplicability({
		templateId: over.templateId ?? "api",
		changedFiles: over.changedFiles ?? [],
		diff: over.diff ?? "",
		requirementsText: over.requirementsText ?? "",
	});

const withFile = (path: string, added: string[]): Input => ({
	changedFiles: [path],
	diff: section(path, added),
});

describe("legal area contract", () => {
	it("is a valid review area", () => {
		expect(ReviewAreaSchema.safeParse("legal").success).toBe(true);
	});
});

describe("legalApplicability", () => {
	const applies: [string, Input][] = [
		[
			"prisma schema adds an email field",
			withFile("api/prisma/schema.prisma", ["  email String @unique"]),
		],
		[
			"prisma migration adds a first_name column",
			withFile("api/prisma/migrations/1/migration.sql", [
				'ALTER TABLE "User" ADD COLUMN "first_name" TEXT;',
			]),
		],
		[
			"prisma schema adds lat and lng",
			withFile("prisma/schema.prisma", ["  lat Float", "  lng Float"]),
		],
		[
			"code reads document.cookie",
			withFile("web/src/consent.ts", ["const raw = document.cookie;"]),
		],
		["code writes localStorage", withFile("web/src/store.ts", ["localStorage.setItem('k', v);"])],
		[
			"code adds gtag analytics",
			withFile("web/index.html", ["<script>gtag('config','G-1')</script>"]),
		],
		["code adds a tracking pixel", withFile("web/src/track.ts", ["loadPixel(id);"])],
		["auth code changed", withFile("api/src/modules/auth/login.ts", ["export const x = 1;"])],
		["session code changed", withFile("api/src/session.ts", ["export const y = 1;"])],
		["a form collects a phone", withFile("web/src/Form.tsx", ['<input name="phone" />'])],
		["requirement mentions RGPD", { requirementsText: "Debe cumplir el RGPD" }],
		["requirement mentions GDPR", { requirementsText: "GDPR consent banner" }],
		["requirement mentions user registration", { requirementsText: "usuario registro con email" }],
		[
			"requirement mentions personal data",
			{ requirementsText: "Store personal data of customers" },
		],
		["requirement mentions privacy", { requirementsText: "Politica de privacidad visible" }],
	];

	it.each(applies)("applies when %s", (_name, input) => {
		const result = run(input);
		expect(result.applies).toBe(true);
		if (result.applies) expect(result.signals.length).toBeGreaterThan(0);
	});

	const skips: [string, Input][] = [
		["nothing changed", {}],
		["a pure css change", withFile("web/src/a.css", [".a { color: red; }"])],
		[
			"a prisma change without personal fields",
			withFile("api/prisma/schema.prisma", ["  sku String", "  price Int"]),
		],
		[
			"personal field names outside prisma files",
			withFile("api/src/util.ts", ["const email = 1;"]),
		],
		["unrelated requirements", { requirementsText: "Render a product catalog with search" }],
	];

	it.each(skips)("is not applicable for %s", (_name, input) => {
		expect(run(input)).toEqual({ applies: false, reason: LEGAL_NOT_APPLICABLE_REASON });
	});

	it("uses the engine reason text", () => {
		expect(LEGAL_NOT_APPLICABLE_REASON).toBe("no personal data processing detected");
	});

	it("ignores removed lines", () => {
		const diff =
			"diff --git a/web/s.ts b/web/s.ts\n--- a/web/s.ts\n+++ b/web/s.ts\n@@ -1 +0,0 @@\n-localStorage.clear();";
		expect(run({ changedFiles: ["web/s.ts"], diff }).applies).toBe(false);
	});
});
