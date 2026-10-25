import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "unit",
					include: ["test/**/*.test.ts"],
					exclude: ["test/docker/**"],
					testTimeout: 20000,
				},
			},
			{
				test: {
					name: "docker",
					setupFiles: ["test/docker/setup-id-salt.ts"],
					include: ["test/docker/**/*.test.ts"],
					testTimeout: 900_000,
					hookTimeout: 120_000,
					fileParallelism: false,
				},
			},
		],
	},
});
