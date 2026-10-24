import { z } from "zod";

const NonEmpty = z.string().min(1);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const ShotPath = z.string().regex(/^shots\/[A-Za-z0-9._-]+\.png$/);

export const ROLE_PATTERN = /^[a-z][a-z0-9_-]{0,30}$/;
export const MAX_CONSOLE_ERRORS = 20;
export const MAX_CONSOLE_ERROR_CHARS = 300;
export const MAX_FOCUS_LABELS = 20;
export const MAX_FOCUS_LABEL_CHARS = 100;

export const UI_VIEWPORTS = [
	{ name: "mobile", width: 390, height: 844 },
	{ name: "desktop", width: 1440, height: 900 },
] as const;

const Role = z.string().regex(ROLE_PATTERN);

const viewportShape = z.strictObject({
	name: NonEmpty,
	width: z.number().int().positive(),
	height: z.number().int().positive(),
});

const capturedShape = {
	status: z.literal("captured"),
	route: NonEmpty,
	as: Role.nullable(),
	authenticated: z.boolean(),
	viewport: viewportShape,
	axe: z.strictObject({
		violations: z.array(
			z.strictObject({
				id: NonEmpty,
				impact: z.string().nullable(),
				help: z.string().max(300),
				nodes: z.number().int().nonnegative(),
			}),
		),
	}),
	overflow: z.strictObject({
		scrollWidth: z.number().int().nonnegative(),
		clientWidth: z.number().int().nonnegative(),
		overflows: z.boolean(),
	}),
	focus: z.strictObject({
		checked: z.number().int().nonnegative(),
		withoutIndicator: z.array(z.string().max(MAX_FOCUS_LABEL_CHARS)).max(MAX_FOCUS_LABELS),
	}),
	consoleErrors: z.array(z.string().max(MAX_CONSOLE_ERROR_CHARS)).max(MAX_CONSOLE_ERRORS),
};

const unavailableShape = {
	status: z.literal("unavailable"),
	route: NonEmpty,
	as: Role.nullable(),
	authenticated: z.literal(false),
	viewport: viewportShape,
	reason: z.string().min(1).max(300),
};

const authMatchesRole = (entry: { as: string | null; authenticated: boolean }): boolean =>
	entry.authenticated === (entry.as !== null);

const entriesOf = <S extends z.ZodType<{ status: string }>>(entry: S) => z.array(entry).min(1);

const uniqueShots = (pages: readonly { status: string; screenshot?: { path: string } }[]) => {
	const paths = pages.flatMap((page) => (page.screenshot ? [page.screenshot.path] : []));
	return new Set(paths).size === paths.length;
};

const RawCapturedSchema = z
	.strictObject({ ...capturedShape, screenshot: z.strictObject({ path: ShotPath }) })
	.refine(authMatchesRole);
const RawUnavailableSchema = z.strictObject(unavailableShape);

export const RawCaptureSchema = z.strictObject({
	pages: entriesOf(z.union([RawCapturedSchema, RawUnavailableSchema])).refine(uniqueShots, {
		message: "duplicate screenshot paths",
	}),
});
export type RawCapture = z.infer<typeof RawCaptureSchema>;

const CapturedSchema = z
	.strictObject({
		...capturedShape,
		screenshot: z.strictObject({
			path: ShotPath,
			sha256: Sha256,
			bytes: z.number().int().positive(),
		}),
	})
	.refine(authMatchesRole);

const PageSchema = z.union([CapturedSchema, z.strictObject(unavailableShape)]);

export const UiEvidenceSchema = z.strictObject({
	schemaVersion: z.literal(1),
	commitSha: NonEmpty,
	scriptSha256: Sha256,
	playwrightVersion: NonEmpty,
	axeVersion: NonEmpty,
	pages: entriesOf(PageSchema).refine(uniqueShots, { message: "duplicate screenshot paths" }),
});
export type UiEvidence = z.infer<typeof UiEvidenceSchema>;
export type UiPage = UiEvidence["pages"][number];
export type CapturedUiPage = Extract<UiPage, { status: "captured" }>;
export type UnavailableUiPage = Extract<UiPage, { status: "unavailable" }>;
