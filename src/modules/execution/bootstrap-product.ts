import { dirname, join } from "node:path";
import {
	renderPlaceholders,
	selectTemplateId,
	toProductName,
	toProductSlug,
} from "../../domain/templates/render.js";
import { type Failure, fail, ok, type Result } from "../../shared/result.js";
import type { AppDeps } from "../deps.js";
import { recordArtifacts } from "../planning/artifacts.js";
import type { ArtifactStore } from "../planning/ports.js";
import type { TargetFiles } from "../runs/ports.js";
import type { GitPort, TargetWriter, TemplateStore } from "./ports.js";
import { commitGuarded } from "./safe-commit.js";

export type BootstrapDeps = AppDeps & {
	targets: TargetFiles;
	templates: TemplateStore;
	writer: TargetWriter;
	git: GitPort;
	artifactStore: ArtifactStore;
	factoryHome: string;
};

export type BootstrapSummary = {
	runId: string;
	templateId: string;
	commitSha: string;
	skipped: boolean;
	recovered: boolean;
	fileCount: number;
};

export type BootstrapError = Failure<string>;

type Staged = {
	stagedSha: string;
	templateId: string;
	fingerprint: string;
	fileCount: number;
	productName: string;
	productSlug: string;
	files: string[];
};

const ENGINE_NAME = "Gregory Software Factory";
const ENGINE_EMAIL = "factory@localhost";
const DEFAULT_BRANCH = "main";
const BOOTSTRAP_ARTIFACT_PATH = "bootstrap/bootstrap-v1.json";
const stagedArtifactPath = (sha: string): string => `bootstrap/staged-${sha}.json`;

const alreadyBootstrapped = (
	deps: BootstrapDeps,
	input: {
		runId: string;
		targetPath: string;
		templateId: string;
		commitSha: string;
		fileCount: number;
	},
): Result<BootstrapSummary, BootstrapError> => {
	const valid = deps.targets.revalidate(input.targetPath);
	if (!valid.ok) return valid;
	const exists = deps.git.commitExists(input.targetPath, input.commitSha);
	if (!exists.ok) return exists;
	if (!exists.value) {
		return fail(
			"bootstrap_inconsistent",
			`Run ${input.runId} recorded bootstrap commit ${input.commitSha} but it is missing from the target`,
		);
	}
	return ok({
		runId: input.runId,
		templateId: input.templateId,
		commitSha: input.commitSha,
		skipped: true,
		recovered: false,
		fileCount: input.fileCount,
	});
};

const parseStaged = (raw: string): Staged | undefined => {
	try {
		const value = JSON.parse(raw) as Partial<Staged>;
		return typeof value.stagedSha === "string" &&
			typeof value.templateId === "string" &&
			typeof value.fingerprint === "string"
			? (value as Staged)
			: undefined;
	} catch {
		return undefined;
	}
};

const recordFinal = (
	deps: BootstrapDeps,
	runId: string,
	staged: Staged,
	recovered: boolean,
): Result<BootstrapSummary, BootstrapError> => {
	const recorded = recordArtifacts(
		deps,
		runId,
		[
			{
				kind: "bootstrap",
				subject: "",
				version: 1,
				path: BOOTSTRAP_ARTIFACT_PATH,
				content: `${JSON.stringify(
					{
						templateId: staged.templateId,
						commitSha: staged.stagedSha,
						productName: staged.productName,
						productSlug: staged.productSlug,
						files: staged.files,
					},
					null,
					2,
				)}\n`,
				producer: "engine",
			},
		],
		() => {
			deps.storage.events.append({
				runId,
				type: "product.bootstrapped",
				payload: {
					templateId: staged.templateId,
					commitSha: staged.stagedSha,
					fileCount: staged.fileCount,
				},
				now: deps.clock.now(),
			});
			return ok(undefined);
		},
	);
	if (!recorded.ok) return recorded;
	return ok({
		runId,
		templateId: staged.templateId,
		commitSha: staged.stagedSha,
		skipped: false,
		recovered,
		fileCount: staged.fileCount,
	});
};

const recoverMovedRepository = (
	deps: BootstrapDeps,
	runId: string,
	targetPath: string,
): Result<BootstrapSummary, BootstrapError> | undefined => {
	const candidates = deps.storage.artifacts
		.list(runId)
		.filter((artifact) => artifact.kind === "bootstrap-staged")
		.reverse();
	for (const artifact of candidates) {
		const read = deps.artifactStore.read(runId, artifact.path);
		if (!read.ok) continue;
		const staged = parseStaged(read.value.toString("utf8"));
		if (!staged) continue;
		const present = deps.git.commitExists(targetPath, staged.stagedSha);
		if (!present.ok && present.error.code === "repo_config_tampered") return present;
		if (!present.ok || !present.value) continue;
		const sealed = deps.git.sealRepo(targetPath, staged.fingerprint);
		if (!sealed.ok) return sealed;
		const head = deps.git.headSha(targetPath);
		if (!head.ok) return head;
		const clean = deps.git.isClean(targetPath);
		if (!clean.ok) return clean;
		if (head.value !== staged.stagedSha || !clean.value) continue;
		return recordFinal(deps, runId, staged, true);
	}
	return undefined;
};

export const bootstrapProduct = (
	deps: BootstrapDeps,
	input: { runId: string },
): Result<BootstrapSummary, BootstrapError> => {
	const { storage, targets, templates, writer, git } = deps;
	const run = storage.runs.get(input.runId);
	if (!run) return fail("run_not_found", `Run ${input.runId} not found`);
	if (run.state !== "PLANNING") {
		return fail("run_not_planning", `Run ${run.id} is ${run.state}; bootstrap requires PLANNING`);
	}
	if (run.targetPath === null) return fail("target_missing", `Run ${run.id} has no target path`);
	const targetPath = run.targetPath;

	const previous = storage.events
		.list(run.id, {})
		.filter((event) => event.type === "product.bootstrapped")
		.at(-1);
	if (previous) {
		return alreadyBootstrapped(deps, {
			runId: run.id,
			targetPath,
			templateId: String(previous.payload.templateId),
			commitSha: String(previous.payload.commitSha),
			fileCount: Number(previous.payload.fileCount ?? 0),
		});
	}

	const resolved = targets.resolve(targetPath);
	if (!resolved.ok) return resolved;
	if (resolved.value.path !== targetPath) {
		return fail("target_changed", `Target ${targetPath} now resolves to ${resolved.value.path}`);
	}
	if (resolved.value.kind === "git_repo") {
		const recovered = recoverMovedRepository(deps, run.id, targetPath);
		if (recovered) return recovered;
		return fail(
			"existing_repo_unsupported",
			`Target ${targetPath} is already a git repository; discovery of existing code is not implemented yet`,
		);
	}

	const selected = selectTemplateId(run.presetIds);
	if (!selected.ok) return selected;
	const loaded = templates.load(selected.value);
	if (!loaded.ok) return loaded;
	const project = storage.projects.findById(run.projectId);
	const productName = toProductName(project?.name ?? "");
	const values = { productName, productSlug: toProductSlug(productName) };
	const renderSet = new Set(loaded.value.manifest.render);
	const files = loaded.value.files.map((file) => ({
		path: file.path,
		content: renderSet.has(file.path)
			? Buffer.from(renderPlaceholders(file.content.toString("utf8"), values), "utf8")
			: file.content,
	}));

	const staging = join(deps.factoryHome, "runs", run.id, "staging");
	const discarded = writer.removeDirectory(staging);
	if (!discarded.ok) return discarded;
	const created = writer.makeDirectory(staging);
	if (!created.ok) return created;
	for (const file of files) {
		const written = writer.writeFile(staging, file.path, file.content);
		if (!written.ok) return written;
	}
	const initialized = git.init(staging, DEFAULT_BRANCH);
	if (!initialized.ok) return initialized;
	const identified = git.configureIdentity(staging, ENGINE_NAME, ENGINE_EMAIL);
	if (!identified.ok) return identified;
	const committed = commitGuarded(git, staging, `chore: scaffold from ${selected.value}`);
	if (!committed.ok) return committed;
	const fingerprint = git.fingerprint(staging);
	if (!fingerprint.ok) return fingerprint;

	const staged: Staged = {
		stagedSha: committed.value,
		templateId: selected.value,
		fingerprint: fingerprint.value,
		fileCount: files.length,
		productName,
		productSlug: values.productSlug,
		files: files.map((file) => file.path).sort(),
	};
	const alreadyStaged = storage.artifacts.find(run.id, "bootstrap-staged", staged.stagedSha, 1);
	const stagedRecord = alreadyStaged
		? ok([])
		: recordArtifacts(
				deps,
				run.id,
				[
					{
						kind: "bootstrap-staged",
						subject: staged.stagedSha,
						version: 1,
						path: stagedArtifactPath(staged.stagedSha),
						content: `${JSON.stringify(staged, null, 2)}\n`,
						producer: "engine",
					},
				],
				() => ok(undefined),
			);
	if (!stagedRecord.ok) return stagedRecord;

	const moved = moveIntoTarget(deps, {
		staging,
		targetPath,
		kind: resolved.value.kind,
		staged,
	});
	if (!moved.ok) return moved;
	return recordFinal(deps, run.id, staged, false);
};

const moveIntoTarget = (
	deps: BootstrapDeps,
	input: { staging: string; targetPath: string; kind: "new" | "empty"; staged: Staged },
): Result<void, BootstrapError> => {
	const { targets, writer, git } = deps;
	const guard = () => targets.revalidate(input.targetPath);
	const prepared = ((): Result<void, BootstrapError> => {
		const first = guard();
		if (!first.ok) return first;
		return input.kind === "empty"
			? writer.removeEmptyDirectory(input.targetPath)
			: writer.makeDirectory(dirname(input.targetPath));
	})();
	if (!prepared.ok) return prepared;
	const last = guard();
	if (!last.ok) return last;
	const renamed = writer.renameDirectory(input.staging, input.targetPath);
	if (!renamed.ok && renamed.error.code !== "cross_device") return renamed;
	if (!renamed.ok) {
		const copied = writer.copyDirectory(input.staging, input.targetPath);
		if (!copied.ok) return copied;
		const sealed = git.sealRepo(input.targetPath, input.staged.fingerprint);
		if (!sealed.ok) return sealed;
		const head = git.headSha(input.targetPath);
		const clean = git.isClean(input.targetPath);
		if (!head.ok || !clean.ok || head.value !== input.staged.stagedSha || !clean.value) {
			return fail(
				"bootstrap_copy_mismatch",
				`The copy of the staged product in ${input.targetPath} does not match commit ${input.staged.stagedSha}`,
			);
		}
		const removed = writer.removeDirectory(input.staging);
		return removed.ok ? ok(undefined) : removed;
	}
	return git.sealRepo(input.targetPath, input.staged.fingerprint);
};
