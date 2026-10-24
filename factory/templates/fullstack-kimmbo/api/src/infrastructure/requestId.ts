import { randomUUID } from "node:crypto";
import type { RequestHandler, Response } from "express";

const VALID_ID = /^[A-Za-z0-9._-]{8,64}$/;

export const requestIdMiddleware: RequestHandler = (req, res, next) => {
	const incoming = req.header("x-request-id");
	const id = incoming !== undefined && VALID_ID.test(incoming) ? incoming : randomUUID();
	req.id = id;
	res.locals.requestId = id;
	res.setHeader("x-request-id", id);
	next();
};

export const getRequestId = (res: Response): string => {
	const id: unknown = res.locals.requestId;
	return typeof id === "string" ? id : "unknown";
};
