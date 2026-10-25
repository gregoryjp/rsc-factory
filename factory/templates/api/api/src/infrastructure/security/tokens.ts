import { createHash, randomBytes } from "node:crypto";

export const generateToken = (): string => randomBytes(32).toString("base64url");

export const hashToken = (token: string): string =>
	createHash("sha256").update(token).digest("hex");
