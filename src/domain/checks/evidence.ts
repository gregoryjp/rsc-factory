import type { Check } from "../../contracts/entities.js";
import { isCommitSha } from "../git/names.js";

export const isCheckEvidenceValid = (check: Check, commitSha: string): boolean => {
	const checked = check.commitSha.toLowerCase();
	return isCommitSha(checked) && checked === commitSha.toLowerCase();
};

export const isCheckPassed = (check: Check): boolean => check.exitCode === 0;
