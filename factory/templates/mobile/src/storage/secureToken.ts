export interface SecureBackend {
	getItemAsync: (key: string) => Promise<string | null>;
	setItemAsync: (key: string, value: string) => Promise<void>;
	deleteItemAsync: (key: string) => Promise<void>;
}

export interface TokenStore {
	get: () => Promise<string | null>;
	set: (token: string) => Promise<void>;
	clear: () => Promise<void>;
}

const DEFAULT_NAMESPACE = "session";

export const createTokenStore = (
	backend: SecureBackend,
	namespace: string = DEFAULT_NAMESPACE,
): TokenStore => {
	const key = `auth.${namespace}.token`;
	return {
		get: () => backend.getItemAsync(key),
		set: async (token) => {
			if (token.trim() === "") throw new Error("Refusing to store an empty token");
			await backend.setItemAsync(key, token);
		},
		clear: () => backend.deleteItemAsync(key),
	};
};
