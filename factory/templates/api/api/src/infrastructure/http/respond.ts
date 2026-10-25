import type { Response } from "express";
import type { ErrorCode } from "../errors.js";
import type { Page } from "../pagination.js";
import { getRequestId } from "../requestId.js";

export const sendData = <T>(res: Response, data: T, status = 200): void => {
	res.status(status).json({ data, meta: { requestId: getRequestId(res) } });
};

export const sendPage = <T>(res: Response, result: Page<T>): void => {
	res
		.status(200)
		.json({ data: result.items, meta: { requestId: getRequestId(res), page: result.page } });
};

export const sendError = (
	res: Response,
	status: number,
	error: { code: ErrorCode; message: string; details?: unknown },
): void => {
	res.status(status).json({ error: { ...error, requestId: getRequestId(res) } });
};
