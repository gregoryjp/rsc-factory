import { Prisma, type PrismaClient } from "@prisma/client";

export const assertTestDatabase = (env: NodeJS.ProcessEnv = process.env): void => {
	if (env.NODE_ENV !== "test") {
		throw new Error("Refusing to run tests: NODE_ENV must be 'test'");
	}
	const url = env.TEST_DATABASE_URL;
	if (url === undefined || url.length === 0) {
		throw new Error("Refusing to run tests: TEST_DATABASE_URL is not set");
	}
	let name: string;
	try {
		name = new URL(url).pathname.replace(/^\//, "");
	} catch {
		throw new Error("Refusing to run tests: TEST_DATABASE_URL is not a valid URL");
	}
	if (!name.endsWith("_test")) {
		throw new Error(`Refusing to run tests: database "${name}" does not end in "_test"`);
	}
	if (env.DATABASE_URL !== url) {
		throw new Error("Refusing to run tests: DATABASE_URL must equal TEST_DATABASE_URL");
	}
};

export const truncateAllTables = async (client: PrismaClient): Promise<void> => {
	const rows = await client.$queryRaw<Array<{ tablename: string }>>`
		SELECT tablename FROM pg_tables
		WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
	if (rows.length === 0) return;
	const tables = Prisma.raw(
		rows.map((row) => `"${row.tablename.replaceAll('"', '""')}"`).join(", "),
	);
	await client.$executeRaw`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`;
};
