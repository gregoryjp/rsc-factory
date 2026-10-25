import { describe, expect, it } from "vitest";
import { createTokenStore, type SecureBackend } from "./secureToken";

const memoryBackend = (): SecureBackend & { entries: Map<string, string> } => {
	const entries = new Map<string, string>();
	return {
		entries,
		getItemAsync: async (key) => entries.get(key) ?? null,
		setItemAsync: async (key, value) => {
			entries.set(key, value);
		},
		deleteItemAsync: async (key) => {
			entries.delete(key);
		},
	};
};

describe("createTokenStore", () => {
	it("returns null before any token is saved", async () => {
		const store = createTokenStore(memoryBackend());
		expect(await store.get()).toBeNull();
	});

	it("saves, reads and clears the token through the secure backend", async () => {
		const backend = memoryBackend();
		const store = createTokenStore(backend);
		await store.set("abc");
		expect(await store.get()).toBe("abc");
		expect(backend.entries.size).toBe(1);
		await store.clear();
		expect(await store.get()).toBeNull();
		expect(backend.entries.size).toBe(0);
	});

	it("rejects an empty token instead of storing it", async () => {
		const backend = memoryBackend();
		const store = createTokenStore(backend);
		await expect(store.set("  ")).rejects.toThrow("empty");
		expect(backend.entries.size).toBe(0);
	});

	it("namespaces the key so two stores do not collide", async () => {
		const backend = memoryBackend();
		await createTokenStore(backend, "a").set("1");
		await createTokenStore(backend, "b").set("2");
		expect(await createTokenStore(backend, "a").get()).toBe("1");
		expect(await createTokenStore(backend, "b").get()).toBe("2");
	});
});
