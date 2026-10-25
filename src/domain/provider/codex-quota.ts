import { z } from "zod";
import { classifyProviderText } from "./quota.js";

export type CodexErrorClass =
	| { kind: "quota_exhausted"; waitUntil: number | null }
	| { kind: "rate_limited_transient" };

const MS_PER_UNIT: Record<string, number> = {
	d: 86_400_000,
	h: 3_600_000,
	m: 60_000,
	s: 1000,
};

const BodySchema = z.object({
	status: z.number().optional(),
	error: z
		.object({
			type: z.string().optional(),
			code: z.string().optional(),
			message: z.string().optional(),
			resets_at: z.number().optional(),
			resets_in_seconds: z.number().optional(),
		})
		.optional(),
});

const DURATION_PATTERN = /try again in\s+((?:\d+\s*[a-z]+[\s,]*(?:and\s+)?)+)/i;
const DURATION_PART = /(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi;
const ABSOLUTE_PATTERN = /try again (?:at|after)\s+([^.\n]+)/i;
const ORDINAL = /(\d+)(st|nd|rd|th)\b/gi;

const durationMs = (text: string): number | null => {
	const match = DURATION_PATTERN.exec(text);
	if (!match?.[1]) return null;
	const parts = [...match[1].matchAll(DURATION_PART)];
	if (parts.length === 0) return null;
	return parts.reduce(
		(sum, part) =>
			sum + Number(part[1]) * (MS_PER_UNIT[(part[2] ?? "").charAt(0).toLowerCase()] ?? 0),
		0,
	);
};

const absoluteMs = (text: string, nowMs: number): number | null => {
	const match = ABSOLUTE_PATTERN.exec(text);
	if (!match?.[1]) return null;
	const phrase = match[1].replace(ORDINAL, "$1").trim();
	const parsed = Date.parse(phrase);
	if (!Number.isNaN(parsed)) return parsed;
	const clock = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(phrase);
	if (!clock) return null;
	const meridiem = clock[3]?.toLowerCase();
	const hour =
		meridiem === undefined
			? Number(clock[1])
			: (Number(clock[1]) % 12) + (meridiem === "pm" ? 12 : 0);
	const candidate = new Date(nowMs);
	candidate.setHours(hour, Number(clock[2] ?? "0"), 0, 0);
	return candidate.getTime() > nowMs ? candidate.getTime() : candidate.getTime() + 86_400_000;
};

const parseBody = (message: string): z.infer<typeof BodySchema> | undefined => {
	try {
		const parsed = BodySchema.safeParse(JSON.parse(message));
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
};

const resetFrom = (
	body: z.infer<typeof BodySchema> | undefined,
	text: string,
	nowMs: number,
): number | null => {
	if (body?.error?.resets_at !== undefined) return body.error.resets_at * 1000;
	if (body?.error?.resets_in_seconds !== undefined) {
		return nowMs + body.error.resets_in_seconds * 1000;
	}
	const relative = durationMs(text);
	return relative === null ? absoluteMs(text, nowMs) : nowMs + relative;
};

export const classifyCodexError = (message: string, nowMs: number): CodexErrorClass | null => {
	const body = parseBody(message);
	const text = body?.error?.message ?? message;
	const label = `${body?.error?.type ?? ""} ${body?.error?.code ?? ""} ${text}`;
	const kind = /usage_limit_reached/i.test(label) ? "quota_exhausted" : classifyProviderText(label);
	if (kind === "quota_exhausted") {
		return { kind, waitUntil: resetFrom(body, text, nowMs) };
	}
	if (kind === "rate_limited_transient" || body?.status === 429) {
		return { kind: "rate_limited_transient" };
	}
	return null;
};
