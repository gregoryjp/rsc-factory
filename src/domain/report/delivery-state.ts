import type { DeliveryStatus } from "./types.js";

export type DeliveryEvent = { type: string; payload: Record<string, unknown> };

export type DeliveryState = {
	status: DeliveryStatus;
	cause: string | null;
	reportCommit: string | null;
	mainCommit: string | null;
};

const text = (value: unknown): string | null =>
	typeof value === "string" && value !== "" ? value : null;

export const deliveryStateOf = (events: readonly DeliveryEvent[]): DeliveryState => {
	const relevant = events.filter(
		(event) => event.type.startsWith("delivery.") && event.type !== "delivery.declared",
	);
	const last = relevant.at(-1);
	const completed = relevant.findLast((event) => event.type === "delivery.completed");
	const committed = relevant.findLast((event) => event.type === "delivery.report_committed");
	const status: DeliveryStatus =
		last === undefined
			? "not_started"
			: last.type === "delivery.completed"
				? "delivered"
				: last.type === "delivery.failed"
					? "failed"
					: "in_progress";
	return {
		status,
		cause: last?.type === "delivery.failed" ? (text(last.payload.cause) ?? "unknown") : null,
		reportCommit: text(completed?.payload.reportCommit) ?? text(committed?.payload.commit),
		mainCommit: text(completed?.payload.mainCommit),
	};
};
