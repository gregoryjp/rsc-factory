import { describe, expect, it } from "vitest";
import { RunStateSchema, TaskStateSchema } from "../src/contracts/states.js";
import { isTerminalRun, RUN_TRANSITIONS, transitionRun } from "../src/domain/run-machine.js";
import { isTerminalTask, TASK_TRANSITIONS, transitionTask } from "../src/domain/task-machine.js";

describe("run state machine", () => {
	it("accepts every transition declared in the table", () => {
		for (const from of RunStateSchema.options) {
			for (const to of RUN_TRANSITIONS[from]) {
				const result = transitionRun({ state: from, deliveryTarget: "local" }, to);
				expect(result, `${from} -> ${to}`).toEqual({ ok: true, value: to });
			}
		}
	});

	it("rejects every transition not declared in the table", () => {
		for (const from of RunStateSchema.options) {
			for (const to of RunStateSchema.options) {
				if (RUN_TRANSITIONS[from].includes(to)) continue;
				const result = transitionRun({ state: from, deliveryTarget: "local" }, to);
				expect(result.ok, `${from} -> ${to}`).toBe(false);
			}
		}
	});

	it.each([
		["CREATED", "SUCCEEDED"],
		["CREATED", "BUILDING"],
		["CANCELED", "CREATED"],
		["CANCELED", "BUILDING"],
		["SUCCEEDED", "BUILDING"],
		["FAILED", "BUILDING"],
	] as const)("rejects %s -> %s", (from, to) => {
		const result = transitionRun({ state: from, deliveryTarget: "local" }, to);
		expect(result).toMatchObject({ ok: false, error: { code: "invalid_transition" } });
	});

	it("makes CANCELED, SUCCEEDED and FAILED terminal", () => {
		for (const state of ["CANCELED", "SUCCEEDED", "FAILED"] as const) {
			expect(isTerminalRun(state)).toBe(true);
			expect(RUN_TRANSITIONS[state]).toEqual([]);
		}
		expect(isTerminalRun("BLOCKED")).toBe(false);
	});

	it("requires a declared delivery target to reach SUCCEEDED", () => {
		expect(transitionRun({ state: "RELEASING", deliveryTarget: null }, "SUCCEEDED")).toMatchObject({
			ok: false,
			error: { code: "delivery_target_required" },
		});
		expect(transitionRun({ state: "RELEASING", deliveryTarget: "local" }, "SUCCEEDED").ok).toBe(
			true,
		);
	});
});

describe("task state machine", () => {
	it("accepts every transition declared in the table", () => {
		for (const from of TaskStateSchema.options) {
			for (const to of TASK_TRANSITIONS[from]) {
				expect(transitionTask(from, to), `${from} -> ${to}`).toEqual({ ok: true, value: to });
			}
		}
	});

	it("rejects every transition not declared in the table", () => {
		for (const from of TaskStateSchema.options) {
			for (const to of TaskStateSchema.options) {
				if (TASK_TRANSITIONS[from].includes(to)) continue;
				expect(transitionTask(from, to).ok, `${from} -> ${to}`).toBe(false);
			}
		}
	});

	it.each([
		["DONE", "RUNNING"],
		["DONE", "READY"],
		["PENDING", "DONE"],
		["PENDING", "LEASED"],
		["CANCELED", "READY"],
		["FAILED", "READY"],
	] as const)("rejects %s -> %s", (from, to) => {
		expect(transitionTask(from, to)).toMatchObject({
			ok: false,
			error: { code: "invalid_transition" },
		});
	});

	it("treats DONE, FAILED and CANCELED as terminal", () => {
		for (const state of ["DONE", "FAILED", "CANCELED"] as const) {
			expect(isTerminalTask(state)).toBe(true);
		}
		expect(isTerminalTask("BLOCKED")).toBe(false);
	});
});
