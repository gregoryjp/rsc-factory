export type ChangeStatus = "added" | "modified" | "deleted";

export type FileChange = {
	path: string;
	status: ChangeStatus;
	scriptsChanged: boolean;
	scriptsAdded: boolean;
	depsChanged: boolean;
	existsInBase: boolean;
};

export type ChangeClassification = {
	blocked: string[];
	review: string[];
	reasons: Record<string, string>;
};

const TEST_FILE = /(\.test\.|\.spec\.|(^|\/)__tests__\/)/;
const TEST_SUPPORT = /(^|\/)(tests?|__fixtures__|__snapshots__)\//;
const TEST_RUNNER_CONFIG = /^(vitest|jest|playwright)\.config\..+$/;
const REVIEW_FILES = new Set([".npmrc", "package-lock.json", ".gitignore"]);
const DEPENDENCY_FIELDS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
];
const GUARD_SCRIPT = /(^|\/)scripts\/check-[^/]*\.mjs$/;
const REVIEW_BASENAME = /^(tsconfig[^/]*\.json|biome\.jsonc?)$/;
const REVIEW_PREFIXES = [".github/", "factory/", ".factory/"] as const;

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

export const isTestFile = (path: string): boolean => TEST_FILE.test(path);

export const isTestSupportPath = (path: string): boolean =>
	TEST_SUPPORT.test(path) && !TEST_FILE.test(path);

export const isTestPath = (path: string): boolean =>
	TEST_FILE.test(path) || TEST_SUPPORT.test(path);

export const isPackageJson = (path: string): boolean => basename(path) === "package.json";

const stableStringify = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
			a < b ? -1 : a > b ? 1 : 0,
		);
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
};

const fieldsOf = (
	text: string,
	keys: readonly string[],
): { ok: true; fields: string } | { ok: false } => {
	try {
		const parsed: unknown = JSON.parse(text);
		const record =
			typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
		const picked = keys.map((key) =>
			record[key] === undefined ? "" : stableStringify(record[key]),
		);
		return { ok: true, fields: picked.join("|") };
	} catch {
		return { ok: false };
	}
};

const emptyFields = (keys: readonly string[]): string => keys.map(() => "").join("|");

const fieldsDiffer = (
	before: string | null,
	after: string | null,
	keys: readonly string[],
): boolean => {
	if (after === null) return before !== null && fieldsOf(before, keys).ok;
	const next = fieldsOf(after, keys);
	if (!next.ok) return true;
	if (before === null) return next.fields !== emptyFields(keys);
	const previous = fieldsOf(before, keys);
	return !previous.ok || previous.fields !== next.fields;
};

export const scriptsDiffer = (before: string | null, after: string | null): boolean =>
	fieldsDiffer(before, after, ["scripts"]);

export type ScriptsChangeKind = "none" | "additive" | "protected";

const CHECK_LIKE_SCRIPT =
	/^(pre|post)|^(check|test|lint|typecheck|format|build|prepare|install|prepack|prepublish|prepublishonly|start|dev)(:|$)/i;

const scriptsOf = (text: string | null): Record<string, string> | undefined => {
	if (text === null) return {};
	try {
		const parsed: unknown = JSON.parse(text);
		const record =
			typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
		const scripts = record.scripts ?? {};
		if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return undefined;
		const entries = Object.entries(scripts as Record<string, unknown>);
		return entries.every(([, value]) => typeof value === "string")
			? Object.fromEntries(entries as [string, string][])
			: undefined;
	} catch {
		return undefined;
	}
};

export const scriptsChangeKind = (
	before: string | null,
	after: string | null,
): ScriptsChangeKind => {
	const previous = scriptsOf(before);
	const next = scriptsOf(after);
	if (previous === undefined || next === undefined) return "protected";
	const removedOrEdited = Object.entries(previous).some(([name, value]) => next[name] !== value);
	if (removedOrEdited) return "protected";
	const added = Object.keys(next).filter((name) => !(name in previous));
	if (added.length === 0) return "none";
	return added.some((name) => CHECK_LIKE_SCRIPT.test(name)) ? "protected" : "additive";
};

export const dependenciesDiffer = (before: string | null, after: string | null): boolean =>
	fieldsDiffer(before, after, DEPENDENCY_FIELDS);

const reviewReason = (change: FileChange): string | undefined => {
	const name = basename(change.path);
	if (
		REVIEW_BASENAME.test(name) ||
		REVIEW_PREFIXES.some((prefix) => change.path.startsWith(prefix))
	) {
		return "config";
	}
	if (REVIEW_FILES.has(name)) return "dependency_or_ignore_file";
	if (isPackageJson(change.path) && change.scriptsAdded) return "package_scripts_added";
	if (isPackageJson(change.path) && change.depsChanged) return "dependencies_changed";
	if (isTestSupportPath(change.path)) return "test_support_changed";
	if (change.status === "deleted" && isTestPath(change.path)) return "test_deleted";
	return undefined;
};

const blockReason = (change: FileChange): string | undefined => {
	if (GUARD_SCRIPT.test(change.path)) return "guard_script";
	if (isPackageJson(change.path) && change.scriptsChanged) return "package_scripts";
	if (TEST_RUNNER_CONFIG.test(basename(change.path))) return "test_runner_config";
	if (isTestFile(change.path) && change.status !== "added" && change.existsInBase) {
		return "base_test_modified";
	}
	return undefined;
};

export const classifyChanges = (changes: readonly FileChange[]): ChangeClassification => {
	const blocked: string[] = [];
	const review: string[] = [];
	const reasons: Record<string, string> = {};
	for (const change of changes) {
		const blockedBecause = blockReason(change);
		const reviewBecause = blockedBecause === undefined ? reviewReason(change) : undefined;
		if (blockedBecause !== undefined) {
			blocked.push(change.path);
			reasons[change.path] = blockedBecause;
		} else if (reviewBecause !== undefined) {
			review.push(change.path);
			reasons[change.path] = reviewBecause;
		}
	}
	return { blocked, review, reasons };
};
