import { z } from "zod";
import { ROLE_PATTERN, type UiEvidence, type UiPage } from "../../contracts/ui-evidence.js";
import { type Failure, fail, ok, type Result } from "../../shared/result.js";

export const UI_NOT_APPLICABLE_REASON = "no UI changes";
export type UiRoute = { path: string; as: string | null };
export const DEFAULT_UI_ROUTES: readonly UiRoute[] = [{ path: "/", as: null }];
const MAX_ROUTES = 10;
const MAX_ROLES = 5;
const ROUTE_PATTERN = /^\/[A-Za-z0-9._~/%-]*$/;
const PRODUCT_TEXT_BUDGET = 4000;
const TRUNCATED_MARK = "\n[truncated: product text exceeded the size cap]";

const isSafePath = (route: string): boolean =>
	ROUTE_PATTERN.test(route) && !route.startsWith("//") && !route.split("/").includes("..");

const SafePath = z.string().refine(isSafePath);
const Role = z.string().regex(ROLE_PATTERN);
const RouteEntry = z.union([
	SafePath.transform((path): UiRoute => ({ path, as: null })),
	z.strictObject({ path: SafePath, as: Role }).transform((entry): UiRoute => entry),
]);

export const parseUiRoutes = (
	text: string | null,
): Result<UiRoute[], Failure<"ui_routes_invalid">> => {
	if (text === null) return ok(DEFAULT_UI_ROUTES.map((route) => ({ ...route })));
	const invalid = (message: string) => fail("ui_routes_invalid" as const, message);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return invalid("ui-routes.json is not valid JSON");
	}
	if (!Array.isArray(parsed) || parsed.length === 0) {
		return invalid("ui-routes.json must be a non-empty array of paths");
	}
	const entries: UiRoute[] = [];
	for (const raw of parsed) {
		const entry = RouteEntry.safeParse(raw);
		if (!entry.success) return invalid(`Invalid route: ${JSON.stringify(raw)}`);
		entries.push(entry.data);
	}
	const unique = new Map(entries.map((entry) => [`${entry.path}|${entry.as ?? ""}`, entry]));
	if (unique.size > MAX_ROUTES) return invalid(`At most ${MAX_ROUTES} routes are allowed`);
	return ok([...unique.values()]);
};

const Credential = z.string().min(1).max(200);
const Label = z.string().min(1).max(100);

const UiAuthSchema = z.strictObject({
	loginPath: SafePath,
	fields: z.strictObject({ username: Label, password: Label }),
	submit: Label,
	accounts: z
		.record(Role, z.strictObject({ username: Credential, password: Credential }))
		.refine((accounts) => {
			const count = Object.keys(accounts).length;
			return count >= 1 && count <= MAX_ROLES;
		}),
});
export type UiAuth = z.infer<typeof UiAuthSchema>;

export const parseUiAuth = (
	text: string | null,
): Result<UiAuth | null, Failure<"ui_auth_invalid">> => {
	if (text === null) return ok(null);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return fail("ui_auth_invalid", "ui-auth.json is not valid JSON");
	}
	const auth = UiAuthSchema.safeParse(parsed);
	return auth.success
		? ok(auth.data)
		: fail("ui_auth_invalid", `ui-auth.json is invalid: ${auth.error.message.slice(0, 200)}`);
};

export const checkRoutesAuth = (
	routes: readonly UiRoute[],
	auth: UiAuth | null,
): Result<void, Failure<"ui_routes_invalid">> => {
	const roles = [...new Set(routes.flatMap((route) => (route.as === null ? [] : [route.as])))];
	if (roles.length === 0) return ok(undefined);
	if (auth === null) {
		return fail(
			"ui_routes_invalid",
			"ui-routes.json uses roles but the product has no ui-auth.json",
		);
	}
	const missing = roles.find((role) => !Object.hasOwn(auth.accounts, role));
	return missing === undefined
		? ok(undefined)
		: fail(
				"ui_routes_invalid",
				`ui-routes.json uses role ${missing} which ui-auth.json does not define`,
			);
};

const isDocPath = (path: string): boolean =>
	/\.md$/i.test(path) || path.startsWith("docs/") || path === "LICENSE";

const touchesWeb = (path: string): boolean => path.startsWith("web/");

const ROOT_UI_FILE =
	/^(package\.json|package-lock\.json|tsconfig[^/]*\.json|biome\.json|vite\.config\.[^/]+)$/;
const NON_UI_DIRS: ReadonlySet<string> = new Set(["api", "docs"]);

const touchesOtherWorkspace = (path: string): boolean => {
	const slash = path.indexOf("/");
	if (slash <= 0) return false;
	const first = path.slice(0, slash);
	return !NON_UI_DIRS.has(first) && !first.startsWith(".");
};

const UI_PATH_RULES: Record<string, (path: string) => boolean> = {
	"fullstack-kimmbo": (path) =>
		touchesWeb(path) || ROOT_UI_FILE.test(path) || touchesOtherWorkspace(path),
	"static-landing": (path) => !isDocPath(path),
};

export type UiApplicability = { applies: true } | { applies: false; reason: string };

export const uiApplicability = (input: {
	templateId: string;
	changedFiles: readonly string[];
}): UiApplicability => {
	const rule = Object.hasOwn(UI_PATH_RULES, input.templateId)
		? (UI_PATH_RULES[input.templateId] ?? touchesWeb)
		: touchesWeb;
	return input.changedFiles.some(rule)
		? { applies: true }
		: { applies: false, reason: UI_NOT_APPLICABLE_REASON };
};

export type EvidenceSummary = { pages: number; axeViolations: number; overflowPages: number };

const isCaptured = (page: UiPage): page is Extract<UiPage, { status: "captured" }> =>
	page.status === "captured";

export const summarizeEvidence = (evidence: UiEvidence): EvidenceSummary => {
	const captured = evidence.pages.filter(isCaptured);
	return {
		pages: evidence.pages.length,
		axeViolations: captured.reduce((sum, page) => sum + page.axe.violations.length, 0),
		overflowPages: captured.filter((page) => page.overflow.overflows).length,
	};
};

export const unavailableEntries = (evidence: UiEvidence): string[] =>
	evidence.pages.flatMap((page) =>
		page.status === "unavailable"
			? [`${page.as ?? "public"} ${page.route} ${page.viewport.name}: ${page.reason}`]
			: [],
	);

const plain = (text: string): string =>
	[...text].map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch)).join("");

const label = (page: UiPage): string =>
	`${page.as ?? "public"} ${page.route} ${page.viewport.width}x${page.viewport.height}`;

const productTextOf = (pages: readonly UiPage[]): string => {
	const lines = pages
		.filter(isCaptured)
		.flatMap((page) => [
			...page.consoleErrors.map((message) => `${label(page)} console: ${plain(message)}`),
			...page.focus.withoutIndicator.map(
				(item) => `${label(page)} focus without indicator: ${plain(item)}`,
			),
		]);
	const text = lines.join("\n");
	return text.length <= PRODUCT_TEXT_BUDGET
		? text
		: `${text.slice(0, PRODUCT_TEXT_BUDGET)}${TRUNCATED_MARK}`;
};

const coverageOf = (pages: readonly UiPage[]): string => {
	const group = (role: string | null): string => {
		const mine = pages.filter((page) => page.as === role);
		const captured = [...new Set(mine.filter(isCaptured).map((page) => page.route))];
		const missing = [
			...new Set(mine.filter((page) => !isCaptured(page)).map((page) => page.route)),
		];
		const head =
			role === null ? "public routes (no login)" : `routes as role ${role} (authenticated)`;
		return `- ${head}: captured ${captured.join(", ") || "none"}; not captured ${missing.join(", ") || "none"}`;
	};
	const roles = [...new Set(pages.flatMap((page) => (page.as === null ? [] : [page.as])))];
	const groups = [null, ...roles].filter((role) => pages.some((page) => page.as === role));
	return groups.map(group).join("\n");
};

export type EvidencePromptView = { json: string; productText: string; coverage: string };

export const evidencePromptView = (evidence: UiEvidence): EvidencePromptView => {
	const pages = evidence.pages.map((page) => {
		if (!isCaptured(page)) return page;
		const { consoleErrors, focus, ...rest } = page;
		return {
			...rest,
			consoleErrorCount: consoleErrors.length,
			focus: { checked: focus.checked, withoutIndicatorCount: focus.withoutIndicator.length },
		};
	});
	return {
		json: JSON.stringify({ ...evidence, pages }, null, 1),
		productText: productTextOf(evidence.pages),
		coverage: coverageOf(evidence.pages),
	};
};
