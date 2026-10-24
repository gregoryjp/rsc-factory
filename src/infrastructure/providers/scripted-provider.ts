import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { err, fail, ok, type Result } from "../../shared/result.js";
import { createFakeProvider, type ScriptedResult } from "./fake-provider.js";
import type { ProviderPort, ProviderRequest } from "./provider-port.js";

export type ScriptedProvider = ProviderPort & { calls: ProviderRequest[] };

const NO_SCRIPT = {
	kind: "provider_error",
	retryable: false,
	message: "No scripted responses for this role",
	costUsd: null,
} as const;

export const createScriptedProvider = (
	scripts: Record<string, readonly ScriptedResult[]>,
): ScriptedProvider => {
	const byRole = new Map(Object.entries(scripts).map(([role, s]) => [role, createFakeProvider(s)]));
	const calls: ProviderRequest[] = [];
	return {
		calls,
		invoke: async (request, schema) => {
			calls.push(request);
			const provider = request.role === undefined ? undefined : byRole.get(request.role);
			return provider ? provider.invoke(request, schema) : err(NO_SCRIPT);
		},
	};
};

const FixtureEntrySchema = z.union([
	z.strictObject({
		output: z.unknown(),
		costUsd: z.number().nullable().default(null),
		writes: z.record(z.string(), z.string()).optional(),
		deletes: z.array(z.string()).optional(),
	}),
	z.strictObject({
		failure: z.strictObject({
			kind: z.enum(["timeout", "budget_exceeded", "invalid_output", "provider_error"]),
			retryable: z.boolean().default(false),
			message: z.string(),
		}),
	}),
]);

const toScripted = (entry: z.infer<typeof FixtureEntrySchema>): ScriptedResult =>
	"failure" in entry
		? { ok: false, error: { ...entry.failure, costUsd: null } }
		: {
				ok: true,
				value: { output: entry.output, costUsd: entry.costUsd, models: ["fake"] },
				...(entry.writes === undefined && entry.deletes === undefined
					? {}
					: {
							edits: {
								...(entry.writes === undefined ? {} : { writes: entry.writes }),
								...(entry.deletes === undefined ? {} : { deletes: entry.deletes }),
							},
						}),
			};

export const loadFixtureScripts = (
	dir: string,
	roles: readonly string[],
	optionalRoles: readonly string[] = [],
): Result<Record<string, ScriptedResult[]>, { code: "fixtures_invalid"; message: string }> => {
	const scripts: Record<string, ScriptedResult[]> = {};
	const present = optionalRoles.filter((role) => existsSync(join(dir, `${role}.json`)));
	for (const role of optionalRoles) if (!present.includes(role)) scripts[role] = [];
	for (const role of [...roles, ...present]) {
		try {
			const raw: unknown = JSON.parse(readFileSync(join(dir, `${role}.json`), "utf8"));
			scripts[role] = z.array(FixtureEntrySchema).parse(raw).map(toScripted);
		} catch (cause) {
			const reason = cause instanceof Error ? cause.message : "unknown error";
			return fail("fixtures_invalid", `Fixture ${role}.json in ${dir}: ${reason}`);
		}
	}
	return ok(scripts);
};
