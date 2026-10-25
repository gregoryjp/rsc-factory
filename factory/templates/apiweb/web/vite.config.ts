import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const devWithoutCsp = (): Plugin => ({
	name: "dev-without-csp",
	apply: "serve",
	transformIndexHtml: (html) =>
		html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/i, ""),
});

export default defineConfig({
	plugins: [react(), devWithoutCsp()],
	server: {
		proxy: {
			"/api": {
				target: "http://localhost:3000",
				rewrite: (path) => path.replace(/^\/api/, ""),
			},
		},
	},
	test: {
		environment: "jsdom",
		include: ["src/**/*.test.{ts,tsx}"],
		setupFiles: ["./src/test/setup.ts"],
		css: { modules: { classNameStrategy: "non-scoped" } },
	},
});
