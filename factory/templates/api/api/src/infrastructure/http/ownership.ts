import { notFound } from "../errors.js";
import type { AuthContext } from "./auth.js";

export const assertOwned = <T extends { ownerId: string }>(
	resource: T | null | undefined,
	auth: AuthContext,
): T => {
	if (resource === null || resource === undefined || resource.ownerId !== auth.userId) {
		throw notFound();
	}
	return resource;
};
