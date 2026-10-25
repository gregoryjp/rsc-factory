import type { Request, Response } from "express";
import type { RequestContext } from "../audit.js";
import { getRequestId } from "../requestId.js";

export const requestContextOf = (req: Request, res: Response): RequestContext => ({
	ip: req.ip ?? null,
	requestId: getRequestId(res),
});
