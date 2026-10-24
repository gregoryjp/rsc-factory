import type { ArtifactKind } from "../../contracts/planning.js";
import { sha256Of } from "../../shared/hash.js";
import { type Failure, ok, type Result } from "../../shared/result.js";
import { recordArtifacts } from "../planning/artifacts.js";
import type { PlanDeps } from "../planning/deps.js";

export const recordVersioned = (
	deps: Pick<PlanDeps, "storage" | "artifactStore" | "clock" | "ids">,
	runId: string,
	kind: ArtifactKind,
	subject: string,
	path: (version: number) => string,
	content: string,
): Result<string, Failure<string>> => {
	const latest = deps.storage.artifacts.latest(runId, kind, subject);
	if (latest !== undefined && latest.sha256 === sha256Of(content)) return ok(latest.path);
	const version = (latest?.version ?? 0) + 1;
	const recorded = recordArtifacts(
		deps,
		runId,
		[{ kind, subject, version, path: path(version), content, producer: "engine" }],
		() => ok(undefined),
	);
	return recorded.ok ? ok(path(version)) : recorded;
};
