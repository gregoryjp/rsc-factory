import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { createErrorHandler } from "./app.js";

const logger = { error: vi.fn() } as unknown as Parameters<typeof createErrorHandler>[0];

describe("errorHandler", () => {
	it("delegates to Express when the headers were already sent", () => {
		const status = vi.fn();
		const json = vi.fn();
		const res = { headersSent: true, status, json } as unknown as Response;
		const next = vi.fn();
		const error = new Error("late failure");
		createErrorHandler(logger)(error, {} as Request, res, next);
		expect(next).toHaveBeenCalledWith(error);
		expect(status).not.toHaveBeenCalled();
		expect(json).not.toHaveBeenCalled();
	});
});
