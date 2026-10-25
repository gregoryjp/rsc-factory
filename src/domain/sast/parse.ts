import { z } from "zod";

export const SastSeveritySchema = z.enum(["low", "medium", "high"]);
export type SastSeverity = z.infer<typeof SastSeveritySchema>;

export const SastFindingSchema = z.object({
	rule: z.string().min(1),
	severity: SastSeveritySchema,
	file: z.string().min(1),
	line: z.number().int().min(1),
	fingerprint: z.string().regex(/^[0-9a-f]{12}$/),
});
export type SastFinding = z.infer<typeof SastFindingSchema>;

export type ParsedSast =
	| { status: "parsed"; scanned: number; findings: SastFinding[] }
	| { status: "unavailable"; reason: string };

const SCANNER_VERSION = 1;
const MARKER = "FACTORY_SAST_RESULT ";
const MAX_REASON_CHARS = 300;

const Output = z.object({
	version: z.literal(SCANNER_VERSION),
	scanned: z.number().int().min(0),
	findings: z.array(SastFindingSchema),
});

const unavailable = (reason: string): ParsedSast => ({
	status: "unavailable",
	reason: reason.slice(0, MAX_REASON_CHARS),
});

export const buildSastArgv = (source: string): string[] => [
	"node",
	"--input-type=module",
	"-e",
	source,
];

export const parseSastOutput = (text: string): ParsedSast => {
	const line = text.split("\n").findLast((candidate) => candidate.startsWith(MARKER));
	if (line === undefined) return unavailable("the SAST scanner produced no result line");
	let raw: unknown;
	try {
		raw = JSON.parse(line.slice(MARKER.length));
	} catch {
		return unavailable("the SAST scanner output is not valid JSON");
	}
	const parsed = Output.safeParse(raw);
	if (!parsed.success) return unavailable("the SAST scanner output has an unexpected shape");
	return { status: "parsed", scanned: parsed.data.scanned, findings: parsed.data.findings };
};
