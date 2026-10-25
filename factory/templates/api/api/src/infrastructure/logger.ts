import { pino } from "pino";
import { env } from "../config/env.js";

export const REDACT_PATHS: readonly string[] = [
	"req.headers.authorization",
	"req.headers.cookie",
	'req.headers["x-api-key"]',
	'req.headers["x-csrf-token"]',
	'res.headers["set-cookie"]',
	"req.body.password",
	"*.password",
	"*.passwordHash",
	"*.accessToken",
	"*.refreshToken",
	"*.accessTokenHash",
	"*.refreshTokenHash",
	"*.token",
	"*.secret",
	"*.apiKey",
];

export const createLogger = (options: { level: string; destination?: NodeJS.WritableStream }) =>
	pino(
		{ level: options.level, redact: { paths: [...REDACT_PATHS], censor: "[REDACTED]" } },
		options.destination,
	);

export const logger = createLogger({ level: env.NODE_ENV === "test" ? "silent" : env.LOG_LEVEL });

export type Logger = typeof logger;
