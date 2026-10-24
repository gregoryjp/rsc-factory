import type { AppDeps } from "../deps.js";

export const STALE_RESERVATION_MS = 45 * 60 * 1000;

export const reconcileStaleReservations = (
	{ storage }: Pick<AppDeps, "storage">,
	input: { runId: string; staleAfterMs: number; now: number },
): number => {
	const stale = storage.budgets
		.openReservations(input.runId)
		.filter((reservation) => reservation.createdAt <= input.now - input.staleAfterMs);
	for (const reservation of stale) {
		storage.budgets.settle({
			reservationId: reservation.id,
			chargeUsd: reservation.amountUsd,
			basis: "unknown_reservation",
			now: input.now,
		});
		storage.events.append({
			runId: input.runId,
			type: "budget.reservation_expired",
			payload: {
				reservationId: reservation.id,
				role: reservation.role,
				amountUsd: reservation.amountUsd,
				attemptId: reservation.attemptId,
				basis: "unknown_reservation",
			},
			now: input.now,
		});
	}
	return stale.length;
};
