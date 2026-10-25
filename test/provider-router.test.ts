import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createFakeProvider } from "../src/infrastructure/providers/fake-provider.js";
import type { ProviderRequest } from "../src/infrastructure/providers/provider-port.js";
import { createRoutingProvider } from "../src/infrastructure/providers/routing-provider.js";

const request = (overrides: Partial<ProviderRequest> = {}): ProviderRequest => ({
	prompt: "p",
	systemPrompt: "s",
	jsonSchema: {},
	model: "m",
	maxBudgetUsd: 0,
	tools: [],
	cwd: ".",
	timeoutMs: 1000,
	...overrides,
});

const answer = (tag: string) => ({
	ok: true as const,
	value: { output: { tag }, costUsd: 0, models: [tag] },
});

describe("routing provider", () => {
	it("sends each request to the provider named by the role config, defaulting to claude", async () => {
		const claude = createFakeProvider([answer("claude"), answer("claude")]);
		const codex = createFakeProvider([answer("codex")]);
		const router = createRoutingProvider({ claude, codex });
		const schema = z.object({ tag: z.string() });

		const viaCodex = await router.invoke(request({ provider: "codex" }), schema);
		const viaClaude = await router.invoke(request({ provider: "claude" }), schema);
		const viaDefault = await router.invoke(request(), schema);

		expect(viaCodex).toMatchObject({ ok: true, value: { output: { tag: "codex" } } });
		expect(viaClaude).toMatchObject({ ok: true, value: { output: { tag: "claude" } } });
		expect(viaDefault).toMatchObject({ ok: true, value: { output: { tag: "claude" } } });
		expect(codex.calls).toHaveLength(1);
		expect(claude.calls).toHaveLength(2);
	});
});
