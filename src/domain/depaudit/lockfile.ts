import { z } from "zod";

const Lockfile = z.looseObject({
	packages: z.record(z.string(), z.looseObject({ link: z.boolean().optional() })),
});

export const hasLockedDependencies = (lockfileText: string | null): boolean => {
	if (lockfileText === null) return false;
	try {
		const parsed = Lockfile.safeParse(JSON.parse(lockfileText));
		if (!parsed.success) return false;
		return Object.entries(parsed.data.packages).some(
			([path, entry]) => path.startsWith("node_modules/") && entry.link !== true,
		);
	} catch {
		return false;
	}
};
