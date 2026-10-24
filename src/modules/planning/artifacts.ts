import type { Artifact, ArtifactKind } from "../../contracts/planning.js";
import { sha256Of } from "../../shared/hash.js";
import { fail, ok, type Result } from "../../shared/result.js";
import type { PlanDeps, PlanError } from "./deps.js";

export type NewArtifactFile = {
	kind: ArtifactKind;
	subject: string;
	version: number;
	path: string;
	content: string;
	producer: string;
};

export type ArtifactDeps = Pick<PlanDeps, "storage" | "artifactStore" | "clock" | "ids">;

export const recordArtifacts = <E extends PlanError>(
	deps: ArtifactDeps,
	runId: string,
	files: readonly NewArtifactFile[],
	within: () => Result<void, E>,
): Result<Artifact[], PlanError> => {
	const { storage, artifactStore, clock, ids } = deps;
	for (const file of files) {
		if (storage.artifacts.find(runId, file.kind, file.subject, file.version)) {
			return fail("artifact_conflict", `Artifact ${file.kind} v${file.version} already recorded`);
		}
	}
	const written = new Map<string, string>();
	for (const file of files) {
		const result = artifactStore.write(runId, file.path, file.content);
		if (!result.ok) return result;
		written.set(file.path, result.value.sha256);
	}
	return storage.transaction<Artifact[], PlanError>(() => {
		const now = clock.now();
		const recorded: Artifact[] = files.map((file) => ({
			id: ids("art"),
			runId,
			kind: file.kind,
			subject: file.subject,
			version: file.version,
			path: file.path,
			sha256: written.get(file.path) ?? "",
			producer: file.producer,
			createdAt: now,
		}));
		for (const artifact of recorded) {
			storage.artifacts.insert(artifact);
			storage.events.append({
				runId,
				type: "artifact.recorded",
				payload: {
					kind: artifact.kind,
					subject: artifact.subject,
					version: artifact.version,
					path: artifact.path,
					sha256: artifact.sha256,
				},
				now,
			});
		}
		const extra = within();
		return extra.ok ? ok(recorded) : extra;
	});
};

export const readVerified = (deps: PlanDeps, artifact: Artifact): Result<string, PlanError> => {
	const read = deps.artifactStore.read(artifact.runId, artifact.path);
	if (!read.ok) return read;
	if (sha256Of(read.value) !== artifact.sha256) {
		return fail(
			"artifact_corrupted",
			`Artifact ${artifact.path} does not match its recorded sha256`,
		);
	}
	return ok(read.value.toString("utf8"));
};

export const specPaths = (version: number) => ({
	json: `spec/spec-v${version}.json`,
	markdown: `spec/spec-v${version}.md`,
});

export const ARCHITECTURE_PATH = "spec/architecture-v1.json";
export const PLAN_PATH = "spec/plan-v1.json";
export const INGEST_PATH = "spec/ingest-v1.json";
export const adrPath = (id: string): string => `spec/adr/${id}.md`;
export const contextPackPath = (taskId: string, version: number): string =>
	`spec/context-packs/${taskId}-v${version}.json`;
