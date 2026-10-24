export type RateLimitClass = "quota_exhausted" | "rate_limited_transient";

const QUOTA_PATTERNS: readonly RegExp[] = [
	/\b(session|usage|weekly|daily|monthly|5[- ]hour)\s+limit\b/i,
	/\bhit your (\w+ )?limit\b/i,
];

const tokensOf = (text: string): string[] =>
	text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length > 0);

const isTransientText = (text: string): boolean => {
	const tokens = tokensOf(text);
	return tokens.some(
		(token, index) =>
			token === "429" ||
			token === "529" ||
			token === "overloaded" ||
			token === "ratelimit" ||
			token === "ratelimited" ||
			(token === "rate" && (tokens[index + 1] === "limit" || tokens[index + 1] === "limited")),
	);
};

export const classifyProviderText = (text: string): RateLimitClass | null => {
	if (QUOTA_PATTERNS.some((pattern) => pattern.test(text))) return "quota_exhausted";
	return isTransientText(text) ? "rate_limited_transient" : null;
};

const RESET_PATTERN = /\bresets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i;

type Wall = { year: number; month: number; day: number };

const offsetMs = (instant: number, timeZone: string | undefined): number => {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		minute: "numeric",
		second: "numeric",
	}).formatToParts(new Date(instant));
	const get = (type: string): number =>
		Number(parts.find((part) => part.type === type)?.value ?? "0");
	const asUtc = Date.UTC(
		get("year"),
		get("month") - 1,
		get("day"),
		get("hour"),
		get("minute"),
		get("second"),
	);
	return asUtc - Math.floor(instant / 1000) * 1000;
};

const wallDate = (instant: number, timeZone: string | undefined): Wall => {
	const shifted = new Date(instant + offsetMs(instant, timeZone));
	return {
		year: shifted.getUTCFullYear(),
		month: shifted.getUTCMonth(),
		day: shifted.getUTCDate(),
	};
};

const instantOf = (
	wall: Wall,
	dayShift: number,
	hour: number,
	minute: number,
	timeZone: string | undefined,
): number => {
	const naive = Date.UTC(wall.year, wall.month, wall.day + dayShift, hour, minute);
	const first = naive - offsetMs(naive, timeZone);
	return naive - offsetMs(first, timeZone);
};

const to24h = (hour: number, meridiem: string | undefined): number | null => {
	if (meridiem === undefined) return hour <= 23 ? hour : null;
	if (hour < 1 || hour > 12) return null;
	const lower = meridiem.toLowerCase();
	return (hour % 12) + (lower === "pm" ? 12 : 0);
};

export const parseResetTime = (text: string, nowMs: number): number | null => {
	const match = RESET_PATTERN.exec(text);
	if (!match) return null;
	const hour = to24h(Number(match[1]), match[3]);
	const minute = Number(match[2] ?? "0");
	if (hour === null || minute > 59) return null;
	const timeZone = match[4]?.trim();
	try {
		const wall = wallDate(nowMs, timeZone);
		const today = instantOf(wall, 0, hour, minute, timeZone);
		return today > nowMs ? today : instantOf(wall, 1, hour, minute, timeZone);
	} catch {
		return null;
	}
};

export const backoffDelayMs = (
	attempt: number,
	config: { baseMs: number; capMs: number },
	random: () => number,
): number => Math.floor(random() * Math.min(config.capMs, config.baseMs * 2 ** (attempt - 1)));
