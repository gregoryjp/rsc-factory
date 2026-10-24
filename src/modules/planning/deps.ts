import type { ProviderPort } from "../../infrastructure/providers/provider-port.js";
import type { Failure } from "../../shared/result.js";
import type { AppDeps } from "../deps.js";
import type { ArtifactStore, FactoryFiles } from "./ports.js";

export type PlanSettings = {
	contextPackMaxBytes: number;
	factoryHome: string;
	providerKind: "claude" | "fake";
};

export type PlanDeps = AppDeps & {
	provider: ProviderPort;
	artifactStore: ArtifactStore;
	factoryFiles: FactoryFiles;
	settings: PlanSettings;
	sleep?: (ms: number) => Promise<void>;
	random?: () => number;
	signal?: AbortSignal;
};

export type PlanError = Failure<string> & {
	errors?: string[];
	sizes?: Record<string, number>;
	waitUntil?: number | null;
	needUsd?: number;
	remainingUsd?: number;
};

export const providerModeOf = (deps: PlanDeps): "real" | "fake" =>
	deps.settings.providerKind === "fake" ? "fake" : "real";
