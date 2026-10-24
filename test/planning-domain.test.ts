import { describe, expect, it } from "vitest";
import type { PlannerOutput, SpecOutput } from "../src/contracts/planning.js";
import { PlannerOutputSchema, SpecOutputSchema } from "../src/contracts/planning.js";
import { blockedTaskReasons, mustRequirementsAllBlocked } from "../src/domain/planning/blocking.js";
import { validateArchitecture, validatePlan, validateSpec } from "../src/domain/planning/gates.js";
import { isSafeExpectedPath } from "../src/domain/planning/paths.js";
import { extractDeclaredReqIds, findUnparsedReqTokens } from "../src/domain/planning/req-ids.js";
import { applyRiskFloor } from "../src/domain/planning/risk.js";
import { diffRequirements } from "../src/domain/planning/spec-diff.js";

const req = (id: string, priority: "must" | "next" = "must") => ({
	id,
	text: `text ${id}`,
	acceptance: ["observable"],
	priority,
	sourceRef: "PRD",
});

const spec = (ids: string[]): SpecOutput => ({
	requirements: ids.map((id) => req(id)),
	assumptions: [],
	contradictions: [],
	outOfScope: [],
	openQuestions: [],
});

const task = (key: string, over: Partial<PlannerOutput["tasks"][number]> = {}) => ({
	key,
	title: key,
	requirementIds: ["REQ-001"],
	dependsOn: [] as string[],
	acceptance: ["done"],
	risk: "low" as const,
	expectedPaths: ["src/a.ts"],
	...over,
});

const errorsOf = (result: { ok: boolean; error?: { errors: string[] } }) =>
	result.ok ? [] : (result.error?.errors ?? []);

describe("extractDeclaredReqIds", () => {
	it("reads REQ ids from list and plain lines, unique and ordered", () => {
		const prd =
			"- REQ-002: b\nREQ-001: a\n  * REQ-003: c\ntext mentioning REQ-009 inline\n- REQ-002: dup";
		expect(extractDeclaredReqIds(prd)).toEqual(["REQ-002", "REQ-001", "REQ-003"]);
	});
	it("returns empty when the PRD declares none", () => {
		expect(extractDeclaredReqIds("# PRD\nno ids here")).toEqual([]);
	});
});

describe("validateSpec", () => {
	it("accepts the exact declared set", () => {
		expect(validateSpec(spec(["REQ-001", "REQ-002"]), ["REQ-001", "REQ-002"]).ok).toBe(true);
	});
	it("rejects invented and missing ids", () => {
		const invented = validateSpec(spec(["REQ-001", "REQ-002", "REQ-099"]), ["REQ-001", "REQ-002"]);
		expect(errorsOf(invented).join("\n")).toContain("REQ-099");
		const missing = validateSpec(spec(["REQ-001"]), ["REQ-001", "REQ-002"]);
		expect(errorsOf(missing).join("\n")).toContain("REQ-002");
	});
	it("accepts generated ids when the PRD declares none", () => {
		expect(validateSpec(spec(["REQ-001", "REQ-005"]), []).ok).toBe(true);
	});
	it("rejects duplicate ids and unknown references", () => {
		const bad: SpecOutput = {
			...spec(["REQ-001", "REQ-001"]),
			assumptions: [
				{
					id: "ASM-001",
					statement: "s",
					reason: "r",
					impact: "i",
					reversible: true,
					requirementIds: ["REQ-042"],
				},
			],
			contradictions: [
				{ id: "CON-001", requirementIds: ["REQ-077"], description: "d", critical: true },
			],
		};
		const text = errorsOf(validateSpec(bad, [])).join("\n");
		expect(text).toContain("Duplicate requirement id REQ-001");
		expect(text).toContain("REQ-042");
		expect(text).toContain("REQ-077");
	});
	it("rejects blank acceptance entries", () => {
		const blank = spec(["REQ-001"]);
		blank.requirements[0] = { ...req("REQ-001"), acceptance: ["  "] };
		expect(validateSpec(blank, []).ok).toBe(false);
	});
});

describe("validatePlan", () => {
	const base = spec(["REQ-001", "REQ-002"]);
	const covering = (extra: PlannerOutput["tasks"] = []): PlannerOutput => ({
		tasks: [task("a"), task("b", { requirementIds: ["REQ-002"] }), ...extra],
	});

	it("orders tasks topologically keeping declaration order among ready tasks", () => {
		const plan: PlannerOutput = {
			tasks: [
				task("c", { dependsOn: ["b"], requirementIds: ["REQ-002"] }),
				task("b", { dependsOn: ["a"] }),
				task("a"),
			],
		};
		const result = validatePlan(plan, base);
		expect(result.ok && result.value.map((t) => t.key)).toEqual(["a", "b", "c"]);
	});
	it("rejects cycles, self deps, unknown deps and duplicate keys", () => {
		const cycle = validatePlan(
			{
				tasks: [
					task("a", { dependsOn: ["b"] }),
					task("b", { dependsOn: ["a"], requirementIds: ["REQ-002"] }),
				],
			},
			base,
		);
		expect(errorsOf(cycle).join("\n")).toMatch(/cycle/i);
		expect(
			errorsOf(
				validatePlan(
					{ tasks: [task("a", { dependsOn: ["a"] }), task("b", { requirementIds: ["REQ-002"] })] },
					base,
				),
			).join("\n"),
		).toMatch(/itself/);
		expect(
			errorsOf(
				validatePlan(
					{
						tasks: [task("a", { dependsOn: ["zzz"] }), task("b", { requirementIds: ["REQ-002"] })],
					},
					base,
				),
			).join("\n"),
		).toContain("zzz");
		expect(errorsOf(validatePlan(covering([task("a")]), base)).join("\n")).toMatch(
			/Duplicate task key a/,
		);
	});
	it("rejects blank acceptance and unknown requirement ids", () => {
		expect(
			errorsOf(
				validatePlan(
					{ tasks: [task("a", { acceptance: [" "] }), task("b", { requirementIds: ["REQ-002"] })] },
					base,
				),
			).join("\n"),
		).toMatch(/acceptance/);
		expect(
			errorsOf(
				validatePlan(
					{
						tasks: [
							task("a", { requirementIds: ["REQ-404"] }),
							task("b", { requirementIds: ["REQ-002"] }),
						],
					},
					base,
				),
			).join("\n"),
		).toContain("REQ-404");
	});
	it("rejects an uncovered must requirement but allows an uncovered next one", () => {
		expect(errorsOf(validatePlan({ tasks: [task("a")] }, base)).join("\n")).toContain("REQ-002");
		const withNext: SpecOutput = {
			...base,
			requirements: [req("REQ-001"), req("REQ-002", "next")],
		};
		expect(validatePlan({ tasks: [task("a")] }, withNext).ok).toBe(true);
	});
});

describe("validateArchitecture", () => {
	const arch = (presetIds: string[]) => ({
		presetIds,
		rationale: "r",
		omitted: [],
		decisions: [],
	});
	it("accepts known presets and combinations", () => {
		expect(validateArchitecture(arch(["backend-express-kimmbo", "web-react-vite"])).ok).toBe(true);
		expect(validateArchitecture(arch(["static-landing"])).ok).toBe(true);
	});
	it("rejects unknown, duplicate and conflicting presets", () => {
		expect(errorsOf(validateArchitecture(arch(["nope"]))).join("\n")).toContain("nope");
		expect(validateArchitecture(arch(["web-react-vite", "web-react-vite"])).ok).toBe(false);
		expect(validateArchitecture(arch(["static-landing", "backend-express-kimmbo"])).ok).toBe(false);
	});
	it("rejects duplicate decision ids", () => {
		const decision = { id: "ADR-001", title: "t", context: "c", decision: "d", alternatives: [] };
		const dup = { ...arch(["static-landing"]), decisions: [decision, decision] };
		expect(validateArchitecture(dup).ok).toBe(false);
	});
});

describe("applyRiskFloor", () => {
	it("raises risk to high on sensitive paths or requirement text", () => {
		const prisma = applyRiskFloor(task("a", { expectedPaths: ["prisma/schema.prisma"] }), []);
		expect(prisma.risk).toBe("high");
		expect(prisma.riskReasons.length).toBeGreaterThan(0);
		const auth = applyRiskFloor(task("a", { expectedPaths: ["src/modules/auth/login.ts"] }), []);
		expect(auth.risk).toBe("high");
		const text = applyRiskFloor(task("a"), ["El operador cambia su contraseña"]);
		expect(text.risk).toBe("high");
	});
	it("keeps the model risk when nothing matches and never lowers it", () => {
		expect(applyRiskFloor(task("a", { risk: "medium" }), ["list tickets"]).risk).toBe("medium");
		expect(applyRiskFloor(task("a", { risk: "high" }), ["list tickets"])).toMatchObject({
			risk: "high",
			riskReasons: [],
		});
	});
});

describe("contradiction blocking", () => {
	const tasks = [
		{ key: "a", requirementIds: ["REQ-001"], dependsOn: [] as string[] },
		{ key: "b", requirementIds: ["REQ-002"], dependsOn: ["a"] },
		{ key: "c", requirementIds: ["REQ-003"], dependsOn: [] as string[] },
	];
	const contradictions = [
		{ id: "CON-001", requirementIds: ["REQ-001"], description: "d", critical: true },
		{ id: "CON-002", requirementIds: ["REQ-003"], description: "d", critical: false },
	];
	it("blocks covering tasks and their dependents, ignoring non-critical ones", () => {
		const reasons = blockedTaskReasons(tasks, contradictions);
		expect([...reasons.keys()]).toEqual(["a", "b"]);
		expect(reasons.get("a")).toContain("CON-001");
		expect(reasons.get("b")).toContain("a");
	});
	it("detects when every must requirement is blocked", () => {
		const s = spec(["REQ-001", "REQ-002"]);
		const all = [
			{ key: "a", requirementIds: ["REQ-001"], dependsOn: [] as string[] },
			{ key: "b", requirementIds: ["REQ-002"], dependsOn: ["a"] },
		];
		expect(mustRequirementsAllBlocked(s.requirements, all, new Set(["a", "b"]))).toBe(true);
		expect(mustRequirementsAllBlocked(s.requirements, all, new Set(["a"]))).toBe(false);
	});
});

describe("diffRequirements", () => {
	it("lists added, removed and modified requirement ids", () => {
		const before = spec(["REQ-001", "REQ-002"]).requirements;
		const after = [{ ...req("REQ-001"), text: "changed" }, req("REQ-003")];
		expect(diffRequirements(before, after)).toEqual(["REQ-001", "REQ-002", "REQ-003"]);
		expect(diffRequirements(before, before)).toEqual([]);
	});
});

describe("schemas", () => {
	it("rejects unknown fields and empty acceptance", () => {
		expect(SpecOutputSchema.safeParse({ ...spec(["REQ-001"]), extra: 1 }).success).toBe(false);
		expect(PlannerOutputSchema.safeParse({ tasks: [task("a", { acceptance: [] })] }).success).toBe(
			false,
		);
	});
});

describe("extractDeclaredReqIds forms", () => {
	it("reads headings, table rows, bold and list forms", () => {
		const prd = [
			"### REQ-001: heading",
			"## REQ-002 \u2014 dash heading",
			"| REQ-003 | table text |",
			"**REQ-004**: bold",
			"- **REQ-005**: bold list",
			"**REQ-006:** bold colon",
			"* REQ-007: star list",
			"REQ-008 - hyphen",
		].join("\n");
		expect(extractDeclaredReqIds(prd)).toEqual([
			"REQ-001",
			"REQ-002",
			"REQ-003",
			"REQ-004",
			"REQ-005",
			"REQ-006",
			"REQ-007",
			"REQ-008",
		]);
	});
	it("accepts ids with four or more digits", () => {
		expect(extractDeclaredReqIds("- REQ-1000: big\n- REQ-001: small")).toEqual([
			"REQ-1000",
			"REQ-001",
		]);
	});
	it("ignores fenced code blocks", () => {
		const prd =
			"- REQ-001: real\n```\n- REQ-050: in code\n```\n~~~\nREQ-051: tilde\n~~~\n- REQ-002: real";
		expect(extractDeclaredReqIds(prd)).toEqual(["REQ-001", "REQ-002"]);
	});
});

describe("findUnparsedReqTokens", () => {
	it("reports REQ tokens that were not captured as declarations", () => {
		const prd = "- REQ-001: a\nsee REQ-009 and REQ-12 and REQ-001\n```\nREQ-050: code\n```";
		const declared = extractDeclaredReqIds(prd);
		expect(findUnparsedReqTokens(prd, declared)).toEqual(["REQ-009", "REQ-12", "REQ-050"]);
	});
	it("reports nothing when every token is declared", () => {
		expect(findUnparsedReqTokens("- REQ-001: a\nrefers to REQ-001", ["REQ-001"])).toEqual([]);
	});
});

describe("expected path gate", () => {
	it("accepts normalized relative POSIX paths", () => {
		for (const path of ["src/a.ts", "web/src/features/tickets/", "README.md", ".github/ci.yml"]) {
			expect(isSafeExpectedPath(path), path).toBe(true);
		}
	});
	it("rejects absolute, traversal, drive, NUL, non-normalized, backslash and .git paths", () => {
		const bad = [
			"/etc/passwd",
			"../x",
			"a/../../x",
			"a/../b",
			"C:/x",
			"c:\\x",
			"a\u0000b",
			"./a",
			"a//b",
			"a/./b",
			"a\\b",
			".git/config",
			"sub/.git/hooks/x",
			".git",
		];
		for (const path of bad) expect(isSafeExpectedPath(path), path).toBe(false);
	});
	it("fails the plan gate for an unsafe expected path", () => {
		const base = spec(["REQ-001"]);
		const result = validatePlan({ tasks: [task("a", { expectedPaths: ["/etc/passwd"] })] }, base);
		expect(errorsOf(result).join("\n")).toContain("/etc/passwd");
		expect(validatePlan({ tasks: [task("a", { expectedPaths: ["src/ok.ts"] })] }, base).ok).toBe(
			true,
		);
	});
});
