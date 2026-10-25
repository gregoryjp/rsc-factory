import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const MARKER = "FACTORY_SAST_RESULT ";
const SCANNER_VERSION = 1;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_LINE_CHARS = 1000;
const SKIPPED_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"coverage",
	".expo",
	".npm-cache",
	"android",
	"ios",
]);
const SKIPPED_PATH = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(test|tests|__tests__|fixtures)\//;
const SCANNED_FILE = /\.(c|m)?(j|t)sx?$|\.html?$|\.json$|\.ya?ml$|\.env\.example$/;
const CODE_FILE = /\.(c|m)?(j|t)sx?$/;
const HTML_FILE = /\.html?$/;
const ANY_FILE = /./;

const RULES = [
	["eval-call", "high", /(^|[^\w.$])eval\s*\(/, CODE_FILE],
	["function-constructor", "high", /\bnew\s+Function\s*\(/, CODE_FILE],
	[
		"command-injection",
		"high",
		/\b(exec|execSync)\s*\(\s*(`[^`]*\$\{|[^)]*["'`]\s*\+|[A-Za-z_$][\w$.]*\s*[,)])/,
		CODE_FILE,
	],
	["shell-spawn", "high", /\bshell\s*:\s*true\b/, CODE_FILE],
	["raw-sql-unsafe", "high", /\$(queryRawUnsafe|executeRawUnsafe)\b/, CODE_FILE],
	["react-raw-html", "high", /dangerouslySetInnerHTML/, CODE_FILE],
	["dom-inner-html", "high", /\.(innerHTML|outerHTML)\s*=[^=]/, CODE_FILE],
	["document-write", "high", /\bdocument\.write(ln)?\s*\(/, CODE_FILE],
	["tls-verification-disabled", "high", /rejectUnauthorized\s*:\s*false/, CODE_FILE],
	["tls-env-disabled", "high", /NODE_TLS_REJECT_UNAUTHORIZED\s*[=:]\s*["']?0/, ANY_FILE],
	["jwt-ignore-expiration", "high", /ignoreExpiration\s*:\s*true/, CODE_FILE],
	["jwt-none-algorithm", "high", /algorithms?\s*:\s*\[?\s*["']none["']/i, CODE_FILE],
	[
		"private-key-material",
		"high",
		/-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
		ANY_FILE,
	],
	["aws-access-key", "high", /\bAKIA[0-9A-Z]{16}\b/, ANY_FILE],
	[
		"hardcoded-secret",
		"high",
		/(api[_-]?key|secret|passwd|password|token)["']?\s*[:=]\s*["'][A-Za-z0-9/+_=-]{20,}["']/i,
		CODE_FILE,
	],
	["weak-hash", "medium", /createHash\(\s*["'](md5|sha1)["']\s*\)/i, CODE_FILE],
	[
		"insecure-random",
		"medium",
		/(token|secret|session|nonce)\w*\s*=.*Math\.random\s*\(/i,
		CODE_FILE,
	],
	["cookie-not-http-only", "medium", /httpOnly\s*:\s*false/, CODE_FILE],
	["cookie-not-secure", "medium", /\bsecure\s*:\s*false/, CODE_FILE],
	["cors-wildcard", "medium", /origin\s*:\s*(["']\*["']|true)/, CODE_FILE],
	[
		"cleartext-http",
		"medium",
		/["'`]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0|10\.0\.2\.2)[\w.-]+\.[a-z]/i,
		CODE_FILE,
	],
	["blank-target-no-rel", "medium", /target=["']_blank["'](?![^>]*rel=)/, HTML_FILE],
	["inline-event-handler", "low", /\son(click|load|error)\s*=\s*["']/i, HTML_FILE],
];

const hashOf = (rule, file, line) =>
	createHash("sha256").update(`${rule}|${file}|${line}`).digest("hex").slice(0, 12);

const walk = (root, dir, out) => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!SKIPPED_DIRS.has(entry.name)) walk(root, full, out);
			continue;
		}
		const rel = relative(root, full).split("\\").join("/");
		if (entry.isFile() && SCANNED_FILE.test(entry.name) && !SKIPPED_PATH.test(rel)) out.push(rel);
	}
};

const scanFile = (root, rel) => {
	const full = join(root, rel);
	if (statSync(full).size > MAX_FILE_BYTES) return [];
	const found = [];
	const lines = readFileSync(full, "utf8").split("\n");
	lines.forEach((raw, index) => {
		if (raw.length > MAX_LINE_CHARS) return;
		const line = raw.trim();
		for (const [rule, severity, pattern, files] of RULES) {
			if (files.test(rel) && pattern.test(line)) {
				found.push({
					rule,
					severity,
					file: rel,
					line: index + 1,
					fingerprint: hashOf(rule, rel, line),
				});
			}
		}
	});
	return found;
};

const root = process.cwd();
const files = [];
walk(root, root, files);
files.sort();
const findings = files.flatMap((rel) => scanFile(root, rel));
process.stdout.write(
	`${MARKER}${JSON.stringify({ version: SCANNER_VERSION, scanned: files.length, findings })}\n`,
);
