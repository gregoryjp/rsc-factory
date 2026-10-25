import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");
const sourceFiles = (dir: string): string[] =>
	readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return /\.(ts|tsx)$/.test(name) && !name.endsWith(".test.ts") ? [path] : [];
	});

const TOKEN_LIKE = /(token|jwt|secret|password|session|credential|auth)/i;

describe("source rules", () => {
	it("never stores token-like values with AsyncStorage", () => {
		const offenders = sourceFiles(SRC).filter((file) => {
			const text = readFileSync(file, "utf8");
			return text.includes("@react-native-async-storage/async-storage") && TOKEN_LIKE.test(text);
		});
		expect(offenders).toEqual([]);
	});

	it("never exposes secrets through EXPO_PUBLIC_ variables", () => {
		const offenders = sourceFiles(SRC).filter((file) =>
			/EXPO_PUBLIC_[A-Z0-9_]*(SECRET|PRIVATE|PASSWORD|TOKEN|API_KEY)/.test(
				readFileSync(file, "utf8"),
			),
		);
		expect(offenders).toEqual([]);
	});
});
