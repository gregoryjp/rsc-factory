import * as SecureStore from "expo-secure-store";
import { createTokenStore, type SecureBackend } from "./secureToken";

const expoSecureBackend: SecureBackend = {
	getItemAsync: (key) => SecureStore.getItemAsync(key),
	setItemAsync: (key, value) => SecureStore.setItemAsync(key, value),
	deleteItemAsync: (key) => SecureStore.deleteItemAsync(key),
};

export const tokenStore = createTokenStore(expoSecureBackend);
