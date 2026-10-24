import type { z } from "zod";
import { err, ok } from "../../shared/result.js";
import { applyEdits, type FileEdits } from "./file-edits.js";
import type {
	ProviderFailure,
	ProviderPort,
	ProviderRequest,
	ProviderSuccess,
} from "./provider-port.js";

export type ScriptedResult =
	| { ok: true; value: ProviderSuccess<unknown>; edits?: FileEdits }
	| { ok: false; error: ProviderFailure };

export type FakeProvider = ProviderPort & { calls: ProviderRequest[] };

export const createFakeProvider = (script: readonly ScriptedResult[]): FakeProvider => {
	const calls: ProviderRequest[] = [];
	return {
		calls,
		invoke: async (request, outputSchema: z.ZodType<unknown>) => {
			const index = calls.length;
			calls.push(request);
			const scripted = script[index];
			if (!scripted) {
				return err({
					kind: "provider_error",
					retryable: false,
					message: "FakeProvider script exhausted",
					costUsd: null,
				});
			}
			if (!scripted.ok) return err(scripted.error);
			const parsed = outputSchema.safeParse(scripted.value.output);
			if (!parsed.success) {
				return err({
					kind: "invalid_output",
					retryable: false,
					message: parsed.error.message,
					costUsd: scripted.value.costUsd ?? 0,
				});
			}
			if (scripted.edits !== undefined) {
				const applied = applyEdits(request.cwd, scripted.edits);
				if (!applied.ok) {
					return err({
						kind: "provider_error",
						retryable: false,
						message: applied.error.message,
						costUsd: scripted.value.costUsd ?? 0,
					});
				}
			}
			return ok({
				...scripted.value,
				costUsd: scripted.value.costUsd ?? 0,
				output: parsed.data,
			}) as never;
		},
	};
};
