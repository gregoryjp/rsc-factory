import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");
const APP_JSON = join(SRC, "..", "app.json");
const SECURE_FETCH = join(SRC, "net", "secureFetch.ts");
const sourceFiles = (dir: string): string[] =>
	readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return /\.(ts|tsx)$/.test(name) && !name.endsWith(".test.ts") ? [path] : [];
	});

const TOKEN_LIKE = /(token|jwt|secret|password|session|credential|auth)/i;
const ALLOWED_ANDROID_PERMISSIONS: readonly string[] = [];
const INTERACTIVE = /<(Pressable|TouchableOpacity|TouchableHighlight|TouchableWithoutFeedback)\b/g;

const offendersOf = (matches: (text: string, file: string) => boolean): string[] =>
	sourceFiles(SRC).filter((file) => matches(readFileSync(file, "utf8"), file));

const countOf = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;

describe("source rules", () => {
	it("never stores token-like values with AsyncStorage", () => {
		const offenders = offendersOf(
			(text) => text.includes("@react-native-async-storage/async-storage") && TOKEN_LIKE.test(text),
		);
		expect(offenders).toEqual([]);
	});

	it("never exposes secrets through EXPO_PUBLIC_ variables", () => {
		const offenders = offendersOf((text) =>
			/EXPO_PUBLIC_[A-Z0-9_]*(SECRET|PRIVATE|PASSWORD|TOKEN|API_KEY)/.test(text),
		);
		expect(offenders).toEqual([]);
	});

	it("never copies token-like values to the clipboard", () => {
		const offenders = offendersOf(
			(text) =>
				/expo-clipboard|@react-native-clipboard|Clipboard\./.test(text) && TOKEN_LIKE.test(text),
		);
		expect(offenders).toEqual([]);
	});

	it("only calls fetch through the https-only wrapper in src/net/secureFetch.ts", () => {
		const offenders = offendersOf(
			(text, file) => file !== SECURE_FETCH && /(^|[^\w.])fetch\s*\(/.test(text),
		);
		expect(offenders).toEqual([]);
	});

	it("never hardcodes cleartext http urls except for local development hosts", () => {
		const offenders = offendersOf((text) =>
			/http:\/\/(?!localhost|127\.0\.0\.1|10\.0\.2\.2|www\.w3\.org)/.test(text),
		);
		expect(offenders).toEqual([]);
	});

	it("gives every interactive element an accessibility role and label", () => {
		const offenders = offendersOf((text) => {
			const interactive = countOf(text, INTERACTIVE);
			return (
				interactive > 0 &&
				(countOf(text, /accessibilityRole=/g) < interactive ||
					countOf(text, /accessibilityLabel=/g) < interactive)
			);
		});
		expect(offenders).toEqual([]);
	});
});

describe("app.json hardening", () => {
	const raw = readFileSync(APP_JSON, "utf8");
	const config = JSON.parse(raw) as {
		expo: { android?: { permissions?: string[] }; extra?: Record<string, unknown> };
	};

	it("keeps App Transport Security and Android cleartext protections on", () => {
		expect(raw).not.toContain("NSAllowsArbitraryLoads");
		expect(raw).not.toMatch(/usesCleartextTraffic"?\s*:\s*true/);
	});

	it("requests no Android permissions beyond the allowlist", () => {
		const requested = config.expo.android?.permissions ?? [];
		expect(requested.filter((name) => !ALLOWED_ANDROID_PERMISSIONS.includes(name))).toEqual([]);
	});

	it("declares no usage description for a capability the app does not use", () => {
		expect(raw).not.toMatch(/NS[A-Za-z]+UsageDescription/);
	});

	it("keeps secrets out of the public app config", () => {
		const keys = Object.keys(config.expo.extra ?? {});
		expect(keys.filter((key) => /(SECRET|PRIVATE|PASSWORD|TOKEN|API_KEY)/i.test(key))).toEqual([]);
	});
});
