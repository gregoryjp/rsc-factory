export type RequirementStatus = "entregado" | "no_entregado" | "sin_evidencia";

export type CheckRef = {
	id: string;
	argv: string[];
	cwd: string;
	exitCode: number;
	commitSha: string;
	logPath: string;
	logSha256: string;
	isolated: boolean;
};

export type ReportFinding = {
	uid: string;
	severity: string;
	status: string;
	title: string;
	file: string | null;
	refutation: string | null;
};

export type ReportReview = {
	area: string;
	verdict: string;
	reason: string | null;
	commit: string;
	findings: ReportFinding[];
};

export type ReportUi =
	| {
			status: "captured";
			dir: string;
			pages: number;
			axeViolations: number;
			overflowPages: number;
			screenshots: string[];
			authenticatedRoles: string[];
	  }
	| { status: "unavailable"; reason: string }
	| { status: "not_applicable" }
	| { status: "not_reviewed" }
	| { status: "sin_evidencia" };

export type ReportTask = {
	key: string;
	title: string;
	state: string;
	requirementIds: string[];
	integrationCommit: string | null;
	blockedReason: string | null;
	retries: number;
	repairs: number;
	checks: CheckRef[];
	reviews: ReportReview[];
	findingCounts: { severity: string; open: number; refuted: number }[];
	acceptedOpen: number;
	requiresReview: { path: string; ack: "ok" | "finding" | "sin_ack" }[];
	ui: ReportUi;
};

export type ReportRequirement = {
	id: string;
	text: string;
	priority: string;
	acceptance: string[];
	status: RequirementStatus;
	taskKeys: string[];
	detail: string;
};

export type DeliveryStatus = "not_started" | "in_progress" | "delivered" | "failed";

export type ReportDelivery = {
	target: string | null;
	status: DeliveryStatus;
	cause: string | null;
	reportCommit: string | null;
	mainCommit: string | null;
	checks: CheckRef[];
};

export type RunReport = {
	schemaVersion: 1;
	runId: string;
	projectName: string;
	state: string;
	inputSha256: string;
	specVersion: number | null;
	integration: { head: string | null; finalCheck: CheckRef | null; finalCheckValid: boolean };
	provider: {
		mode: "fake" | "real" | "none";
		phases: { planning: string[]; build: string[]; review: string[] };
	};
	runner: {
		isolation: "isolated" | "host" | "mixed" | "none";
		isolated: number;
		notIsolated: number;
	};
	requirements: ReportRequirement[];
	tasks: ReportTask[];
	assumptions: {
		id: string;
		statement: string;
		impact: string;
		reversible: boolean;
		requirementIds: string[];
	}[];
	contradictions: {
		id: string;
		description: string;
		critical: boolean;
		requirementIds: string[];
	}[];
	retries: { total: number; repairs: number };
	budget: {
		budgetUsd: number;
		chargedReportedUsd: number;
		chargedUnknownUsd: number;
		reservedUsd: number;
		remainingUsd: number;
		calls: { role: string; calls: number }[];
		retries: number;
	};
	delivery: ReportDelivery;
	release: { status: string };
	limitations: string[];
	nextStep: string;
};
