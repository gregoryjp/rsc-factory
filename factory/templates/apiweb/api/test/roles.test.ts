import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Prisma } from "@prisma/client";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/infrastructure/database.js";

const SCRIPTS = join(import.meta.dirname, "..", "scripts", "db");

const statementsOf = (file: string): string[] =>
	readFileSync(join(SCRIPTS, file), "utf8")
		.split(/\n\s*\n/)
		.map((chunk) => chunk.trim())
		.filter((chunk) => chunk.length > 0);

const provision = async (): Promise<void> => {
	for (const file of ["01-roles.sql", "02-grants.sql"]) {
		for (const statement of statementsOf(file)) {
			await prisma.$executeRaw`${Prisma.raw(statement)}`;
		}
	}
};

const asRuntime = async (statement: string): Promise<string | null> => {
	try {
		await prisma.$transaction(async (tx) => {
			await tx.$executeRaw`SET LOCAL ROLE app_runtime`;
			await tx.$executeRaw`${Prisma.raw(statement)}`;
			throw new Error("rollback");
		});
		return null;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return message.includes("rollback") && !message.includes("permission") ? null : message;
	}
};

describe("least-privilege database roles", () => {
	beforeAll(async () => {
		await provision();
	});

	it("creates login roles without superuser, createdb, createrole or replication", async () => {
		const rows = await prisma.$queryRaw<
			Array<{
				rolname: string;
				rolsuper: boolean;
				rolcreatedb: boolean;
				rolcreaterole: boolean;
				rolreplication: boolean;
				rolcanlogin: boolean;
			}>
		>`SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin
			FROM pg_roles WHERE rolname IN ('app_runtime', 'app_migrator') ORDER BY rolname`;
		expect(rows.map((row) => row.rolname)).toEqual(["app_migrator", "app_runtime"]);
		for (const row of rows) {
			expect(row.rolsuper).toBe(false);
			expect(row.rolcreatedb).toBe(false);
			expect(row.rolcreaterole).toBe(false);
			expect(row.rolreplication).toBe(false);
			expect(row.rolcanlogin).toBe(true);
		}
	});

	it("is safe to run twice", async () => {
		await expect(provision()).resolves.toBeUndefined();
	});

	it("lets the runtime role use application tables with DML only", async () => {
		expect(await asRuntime(`SELECT count(*) FROM "User"`)).toBeNull();
		expect(
			await asRuntime(
				`INSERT INTO "User" ("id", "email", "passwordHash") VALUES ('r1', 'r1@example.com', 'x')`,
			),
		).toBeNull();
		expect(await asRuntime(`UPDATE "User" SET "role" = 'USER'`)).toBeNull();
		expect(await asRuntime(`DELETE FROM "User"`)).toBeNull();
	});

	it("denies the runtime role every DDL and administrative statement", async () => {
		const denied = [
			`CREATE TABLE "Evil" ("id" TEXT)`,
			`DROP TABLE "User"`,
			`ALTER TABLE "User" ADD COLUMN "x" TEXT`,
			`TRUNCATE TABLE "User"`,
			`CREATE ROLE intruder`,
			`CREATE SCHEMA evil`,
			`DROP TRIGGER "AuditEvent_append_only" ON "AuditEvent"`,
		];
		for (const statement of denied) {
			const message = await asRuntime(statement);
			expect(message, statement).toMatch(/permission denied|must be owner/);
		}
	});

	it("keeps the audit table append-only and migration history unreadable for the runtime role", async () => {
		expect(
			await asRuntime(`INSERT INTO "AuditEvent" ("id", "action") VALUES ('e1', 'demo.created')`),
		).toBeNull();
		expect(await asRuntime(`SELECT count(*) FROM "AuditEvent"`)).toBeNull();
		expect(await asRuntime(`UPDATE "AuditEvent" SET "action" = 'x'`)).toMatch(/permission denied/);
		expect(await asRuntime(`DELETE FROM "AuditEvent"`)).toMatch(/permission denied/);
		expect(await asRuntime(`SELECT count(*) FROM "_prisma_migrations"`)).toMatch(
			/permission denied/,
		);
	});
});
