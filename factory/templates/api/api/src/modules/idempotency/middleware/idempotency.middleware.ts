import type { NextFunction, Request, RequestHandler, Response } from "express";
import { idempotencyInProgress, idempotencyKeyReused } from "../../../infrastructure/errors.js";
import { getAuth } from "../../../infrastructure/http/auth.js";
import type { Logger } from "../../../infrastructure/logger.js";
import { IdempotencyKeySchema } from "../schemas/idempotency.schemas.js";
import { fingerprintRequest, type IdempotencyService } from "../services/idempotency.service.js";
import type { BeginOutcome } from "../types/idempotency.types.js";

type Context = {
	req: Request;
	res: Response;
	next: NextFunction;
	service: IdempotencyService;
	logger: Pick<Logger, "error">;
	userId: string;
	key: string;
};

type Handlers = {
	[K in BeginOutcome["kind"]]: (outcome: Extract<BeginOutcome, { kind: K }>, ctx: Context) => void;
};

const report =
	(ctx: Context, event: string) =>
	(error: unknown): void => {
		ctx.logger.error({ err: error, event }, "idempotency store failed");
	};

const capture = (ctx: Context): void => {
	const { res, service, userId, key } = ctx;
	let stored = false;
	const sendJson = res.json.bind(res);
	res.json = (body) => {
		stored = true;
		service
			.finish(userId, key, res.statusCode, body)
			.catch(report(ctx, "finish"))
			.then(() => sendJson(body));
		return res;
	};
	res.once("finish", () => {
		if (stored) return;
		stored = true;
		service.finish(userId, key, res.statusCode, null).catch(report(ctx, "finish"));
	});
	res.once("close", () => {
		if (res.writableFinished || stored) return;
		service.abandon(userId, key).catch(report(ctx, "abandon"));
	});
};

const HANDLERS: Handlers = {
	proceed: (_outcome, ctx) => {
		capture(ctx);
		ctx.next();
	},
	replay: (outcome, ctx) => {
		ctx.res.setHeader("Idempotent-Replayed", "true");
		ctx.res.status(outcome.status);
		if (outcome.body === null || outcome.body === undefined) ctx.res.end();
		else ctx.res.json(outcome.body);
	},
	mismatch: (_outcome, ctx) => ctx.next(idempotencyKeyReused()),
	in_progress: (_outcome, ctx) => ctx.next(idempotencyInProgress()),
};

export const createIdempotencyMiddleware =
	(service: IdempotencyService, logger: Pick<Logger, "error">): RequestHandler =>
	async (req, res, next) => {
		try {
			const header = req.header("idempotency-key");
			if (header === undefined) {
				next();
				return;
			}
			const key = IdempotencyKeySchema.parse(header);
			const userId = getAuth(res).userId;
			const outcome = await service.begin(
				userId,
				key,
				fingerprintRequest(req.method, req.originalUrl, req.body),
			);
			const handle = HANDLERS[outcome.kind] as (outcome: BeginOutcome, ctx: Context) => void;
			handle(outcome, { req, res, next, service, logger, userId, key });
		} catch (error) {
			next(error);
		}
	};
