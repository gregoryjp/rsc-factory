import { type Failure, fail, ok, type Result } from "../../shared/result.js";

const GIT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;

export const parseGitName = (value: string): Result<string, Failure<"invalid_git_name">> =>
	GIT_NAME.test(value)
		? ok(value)
		: fail(
				"invalid_git_name",
				`Invalid name (expected ${GIT_NAME.source}): ${JSON.stringify(value)}`,
			);

export const parseCommitRef = (value: string): Result<string, Failure<"invalid_git_name">> =>
	COMMIT_SHA.test(value) ? ok(value) : parseGitName(value);

export const isCommitSha = (value: string): boolean => COMMIT_SHA.test(value);

const BRANCH_SEGMENTS_MAX = 3;

export const parseBranchName = (value: string): Result<string, Failure<"invalid_git_name">> => {
	const segments = value.split("/");
	return segments.length <= BRANCH_SEGMENTS_MAX &&
		segments.every((segment) => GIT_NAME.test(segment))
		? ok(value)
		: fail(
				"invalid_git_name",
				`Invalid branch name (segments must match ${GIT_NAME.source}): ${JSON.stringify(value)}`,
			);
};
