import { pino } from "pino";
import { env } from "../config/env.js";

export const logger = pino({
	level: env.NODE_ENV === "test" ? "silent" : env.LOG_LEVEL,
	redact: [
		"req.headers.authorization",
		"req.headers.cookie",
		'res.headers["set-cookie"]',
		"req.body.password",
		"*.password",
		"*.passwordHash",
		"*.accessToken",
		"*.refreshToken",
	],
});

export type Logger = typeof logger;
