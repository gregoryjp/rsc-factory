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
	})
	.superRefine((value, ctx) => {
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
