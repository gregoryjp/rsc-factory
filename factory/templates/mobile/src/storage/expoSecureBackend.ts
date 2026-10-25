import * as SecureStore from "expo-secure-store";
import { createTokenStore, type SecureBackend } from "./secureToken";

export const createExpoSecureBackend = (requireAuthentication: boolean): SecureBackend => {
	const options = { requireAuthentication };
	return {
		getItemAsync: (key) => SecureStore.getItemAsync(key, options),
		setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, options),
		deleteItemAsync: (key) => SecureStore.deleteItemAsync(key, options),
	};
};

export const tokenStore = createTokenStore(createExpoSecureBackend(false));
