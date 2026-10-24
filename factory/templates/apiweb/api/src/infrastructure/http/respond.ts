import type { Response } from "express";
import type { ErrorCode } from "../errors.js";
import { getRequestId } from "../requestId.js";

export const sendData = <T>(res: Response, data: T, status = 200): void => {
	res.status(status).json({ data, meta: { requestId: getRequestId(res) } });
};

export const sendError = (
	res: Response,
	status: number,
	error: { code: ErrorCode; message: string; details?: unknown },
): void => {
	res.status(status).json({ error: { ...error, requestId: getRequestId(res) } });
};
