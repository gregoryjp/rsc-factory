import { createHash } from "node:crypto";

export const sha256Of = (content: string | Buffer): string =>
	createHash("sha256").update(content).digest("hex");
