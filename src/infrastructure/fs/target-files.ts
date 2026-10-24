import { lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { TargetKind } from "../../contracts/planning.js";
import type { TargetFiles } from "../../modules/runs/ports.js";
import { fail, ok } from "../../shared/result.js";

const MAX_SYMLINK_HOPS = 40;

const resolveReal = (input: string): string | undefined => {
	let current = resolve(input);
	let rest: string[] = [];
	let hops = 0;
	for (;;) {
		try {
			return join(realpathSync(current), ...rest);
		} catch {
			const isLink = (() => {
				try {
					return lstatSync(current).isSymbolicLink();
				} catch {
					return false;
				}
			})();
			if (isLink) {
				hops += 1;
				if (hops > MAX_SYMLINK_HOPS) return undefined;
				current = resolve(dirname(current), readlinkSync(current));
				continue;
			}
			const parent = dirname(current);
			if (parent === current) return undefined;
			rest = [basename(current), ...rest];
			current = parent;
		}
	}
};

const isInside = (child: string, parent: string): boolean => {
	const rel = relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

const isDirectory = (path: string): boolean => {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
};

const exists = (path: string): boolean => {
	try {
		statSync(path);
		return true;
	} catch {
		return false;
	}
};

const nearestExisting = (path: string): string => {
	let current = path;
	while (!exists(current) && dirname(current) !== current) current = dirname(current);
	return current;
};

export const createFsTargetFiles = (config: {
	repoRoot: string;
	factoryHome: string;
}): TargetFiles => {
	const checkOutsideFactory = (input: string) => {
		const target = resolveReal(input);
		if (target === undefined) {
			return fail("target_unresolvable", `Could not resolve target path: ${input}`);
		}
		const protectedRoots = [config.repoRoot, config.factoryHome].flatMap((root) => {
			const real = resolveReal(root);
			return real === undefined ? [] : [real];
		});
		for (const root of protectedRoots) {
			if (isInside(target, root) || isInside(root, target)) {
				return fail(
					"target_inside_factory",
					`Target ${target} overlaps the factory (${root}); choose a separate directory`,
				);
			}
		}
		return ok(target);
	};
	return {
		revalidate: (expectedPath) => {
			const checked = checkOutsideFactory(expectedPath);
			if (!checked.ok) return checked;
			return checked.value === expectedPath
				? ok(undefined)
				: fail(
						"target_changed",
						`Target ${expectedPath} now resolves to ${checked.value}; refusing to write`,
					);
		},
		resolve: (input) => {
			const checked = checkOutsideFactory(input);
			if (!checked.ok) return checked;
			const target = checked.value;
			const existing = nearestExisting(target);
			if (!isDirectory(existing)) {
				return fail(
					"target_not_directory",
					`Target or one of its parents is not a directory: ${existing}`,
				);
			}
			if (existing !== target) return ok({ path: target, kind: "new" as TargetKind });
			const entries = readdirSync(target);
			if (entries.length === 0) return ok({ path: target, kind: "empty" as TargetKind });
			if (entries.includes(".git")) return ok({ path: target, kind: "git_repo" as TargetKind });
			return fail("target_not_empty", `Target ${target} is not empty and is not a git repository`);
		},
	};
};
