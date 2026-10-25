import { hash, verify } from "@node-rs/argon2";

const ARGON2ID_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export const hashPassword = (password: string): Promise<string> => hash(password, ARGON2ID_OPTIONS);

export const verifyPassword = async (passwordHash: string, password: string): Promise<boolean> => {
	try {
		return await verify(passwordHash, password);
	} catch {
		return false;
	}
};
