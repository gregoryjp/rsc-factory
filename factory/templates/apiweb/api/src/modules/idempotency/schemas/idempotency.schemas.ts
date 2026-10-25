import { z } from "zod";

export const IdempotencyKeySchema = z
	.string()
	.min(8)
	.max(128)
	.regex(/^[A-Za-z0-9._:-]+$/);
