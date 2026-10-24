import { defineConfig } from "vitest/config";
import { loadTestEnv } from "./test/loadTestEnv.js";

loadTestEnv();

export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.test.ts", "test/**/*.test.ts"],
		globalSetup: ["./test/globalSetup.ts"],
		setupFiles: ["./test/setup.ts"],
		fileParallelism: false,
		testTimeout: 15_000,
		hookTimeout: 30_000,
	},
});
