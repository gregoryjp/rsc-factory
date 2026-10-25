import { z } from "zod";

const EnvSchema = z
	.object({
		NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
		PORT: z.coerce.number().int().min(1).max(65535).default(3000),
		DATABASE_URL: z.string().url(),
		LOG_LEVEL: z
			.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
			.default("info"),
		CORS_ORIGINS: z
			.string()
			.default("")
			.transform((value) =>
				value
					.split(",")
					.map((origin) => origin.trim())
					.filter((origin) => origin.length > 0),
			),
		TRUST_PROXY: z
			.string()
			.default("false")
			.transform((value, ctx) => {
				const normalized = value.trim().toLowerCase();
				if (normalized === "" || normalized === "false") return false;
				if (/^\d{1,2}$/.test(normalized)) return Number(normalized);
				ctx.addIssue({ code: "custom", message: "TRUST_PROXY must be 'false' or a hop count" });
				return z.NEVER;
			}),
		RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
		RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),
		RATE_LIMIT_AUTH_MAX: z.coerce.number().int().min(1).default(10),
		REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).default(30_000),
	})
	.superRefine((value, ctx) => {
		const issue = (path: string, message: string): void =>
			ctx.addIssue({ code: "custom", path: [path], message });
		if (value.RATE_LIMIT_AUTH_MAX > value.RATE_LIMIT_MAX) {
			issue("RATE_LIMIT_AUTH_MAX", "RATE_LIMIT_AUTH_MAX must not exceed RATE_LIMIT_MAX");
		}
		if (value.NODE_ENV === "production") {
			if (value.RATE_LIMIT_WINDOW_MS < 10_000 || value.RATE_LIMIT_WINDOW_MS > 3_600_000) {
				issue("RATE_LIMIT_WINDOW_MS", "must be between 10000 and 3600000 in production");
			}
			if (value.RATE_LIMIT_MAX > 10_000) {
				issue("RATE_LIMIT_MAX", "must be at most 10000 in production");
			}
			if (value.RATE_LIMIT_AUTH_MAX > 100) {
				issue("RATE_LIMIT_AUTH_MAX", "must be at most 100 in production");
			}
		}
		if (value.NODE_ENV === "production" && value.CORS_ORIGINS.length === 0) {
			ctx.addIssue({
				code: "custom",
				path: ["CORS_ORIGINS"],
				message: "CORS_ORIGINS is required in production",
			});
		}
	});

export type Env = z.infer<typeof EnvSchema>;

export const parseEnv = (source: NodeJS.ProcessEnv): Env => {
	const parsed = EnvSchema.safeParse(source);
	if (!parsed.success) {
		const details = parsed.error.issues
			.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
			.join("; ");
		throw new Error(`Invalid environment: ${details}`);
	}
	return parsed.data;
};

export const env: Env = parseEnv(process.env);
