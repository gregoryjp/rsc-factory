import { posix } from "node:path";

const DRIVE_LETTER = /^[A-Za-z]:/;

export const isSafeExpectedPath = (path: string): boolean => {
	if (path.length === 0 || path.includes("\0") || path.includes("\\")) return false;
	if (path.startsWith("/") || DRIVE_LETTER.test(path)) return false;
	if (posix.normalize(path) !== path) return false;
	return !path.split("/").some((segment) => segment === ".." || segment === ".git");
};
