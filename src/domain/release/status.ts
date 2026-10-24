export type ReleaseStatus =
	| "NOT_STARTED"
	| "PLANNED"
	| "DEPLOYING"
	| "SMOKING"
	| "FAILED_SMOKE"
	| "HEALTHY";

const STATUS_BY_EVENT: Record<string, ReleaseStatus> = {
	"release.planned": "PLANNED",
	"release.started": "DEPLOYING",
	"release.deployed": "SMOKING",
	"release.smoke_passed": "HEALTHY",
	"release.healthy": "HEALTHY",
	"release.smoke_failed": "FAILED_SMOKE",
	"release.rollback_recorded": "FAILED_SMOKE",
};

export const releaseStatusOf = (events: readonly { type: string }[]): ReleaseStatus =>
	events.reduce<ReleaseStatus>(
		(status, event) => STATUS_BY_EVENT[event.type] ?? status,
		"NOT_STARTED",
	);
