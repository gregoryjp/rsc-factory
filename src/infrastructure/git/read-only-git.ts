import type { GitPort } from "../../modules/execution/ports.js";
import { createGit } from "./git.js";

export type ReadOnlyGitPort = Pick<
	GitPort,
	"headSha" | "snapshot" | "statusPorcelainV2" | "listFiles" | "commitExists"
>;

export const createReadOnlyGit = (config: {
	factoryHome: string;
	baseEnv: Readonly<Record<string, string>>;
}): ReadOnlyGitPort => {
	const git = createGit({ ...config, unsealed: true });
	return {
		headSha: git.headSha,
		snapshot: git.snapshot,
		statusPorcelainV2: git.statusPorcelainV2,
		listFiles: git.listFiles,
		commitExists: git.commitExists,
	};
};
