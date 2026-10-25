export type ErrorCode =
	| "VALIDATION_ERROR"
	| "INVALID_JSON"
	| "PAYLOAD_TOO_LARGE"
	| "NOT_FOUND"
	| "UNAUTHORIZED"
	| "FORBIDDEN"
	| "CONFLICT"
	| "RATE_LIMITED"
	| "REQUEST_TIMEOUT"
	| "SERVICE_UNAVAILABLE"
	| "INTERNAL_ERROR";

export class AppError extends Error {
	readonly status: number;
	readonly code: ErrorCode;
	readonly details?: unknown;

	constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
		super(message);
		this.name = "AppError";
		this.status = status;
		this.code = code;
		this.details = details;
	}
}

export const isAppError = (value: unknown): value is AppError => value instanceof AppError;

export const validationError = (details?: unknown): AppError =>
	new AppError(400, "VALIDATION_ERROR", "Request validation failed", details);

export const notFound = (message = "Resource not found"): AppError =>
	new AppError(404, "NOT_FOUND", message);

export const serviceUnavailable = (message: string): AppError =>
	new AppError(503, "SERVICE_UNAVAILABLE", message);

export const unauthorized = (message = "Authentication required"): AppError =>
	new AppError(401, "UNAUTHORIZED", message);

export const forbidden = (message = "Forbidden"): AppError =>
	new AppError(403, "FORBIDDEN", message);

export const conflict = (message: string): AppError => new AppError(409, "CONFLICT", message);
