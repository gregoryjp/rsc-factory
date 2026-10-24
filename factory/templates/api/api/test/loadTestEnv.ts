import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const loadTestEnv = (): void => {
	const file = resolve(import.meta.dirname, "..", ".env.test");
	if (existsSync(file)) process.loadEnvFile(file);
	process.env.NODE_ENV = "test";
	const testUrl = process.env.TEST_DATABASE_URL;
	if (testUrl !== undefined && testUrl.length > 0) process.env.DATABASE_URL = testUrl;
};
