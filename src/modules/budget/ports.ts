import type { BudgetBasis, BudgetEntryKind } from "../../contracts/budget.js";
import type { Failure, Result } from "../../shared/result.js";

export type BudgetEntry = {
	id: number;
	runId: string;
	kind: BudgetEntryKind;
	role: string;
	attemptId: number | null;
	reservationId: number | null;
	amountUsd: number;
	basis: BudgetBasis;
	createdAt: number;
};

export type OpenReservation = {
	id: number;
	role: string;
	amountUsd: number;
	attemptId: number | null;
	createdAt: number;
};

export type BudgetSummary = {
	budgetUsd: number;
	chargedReportedUsd: number;
	chargedUnknownUsd: number;
	reservedUsd: number;
	remainingUsd: number;
	callsByRole: Record<string, number>;
	retries: number;
};

export type BudgetRepository = {
	limit: (runId: string) => number;
	setLimit: (runId: string, budgetUsd: number) => void;
	reserve: (input: {
		runId: string;
		role: string;
		amountUsd: number;
		now: number;
	}) => Result<number, Failure<"budget_exhausted"> & { remainingUsd: number }>;
	attach: (reservationId: number, attemptId: number) => void;
	settle: (input: {
		reservationId: number;
		chargeUsd: number;
		basis: "reported" | "unknown_reservation";
		now: number;
	}) => void;
	openReservations: (runId: string) => OpenReservation[];
	entries: (runId: string) => BudgetEntry[];
	summary: (runId: string) => BudgetSummary;
};
