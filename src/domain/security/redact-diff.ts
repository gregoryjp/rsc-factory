import {
	AWS_KEY_ID,
	ENV_FILE,
	EXAMPLE_FILE,
	PRIVATE_KEY_BEGIN,
	PRIVATE_KEY_END,
	SECRET_ASSIGNMENT,
	type SecretRule,
} from "./secret-scan.js";

export type RedactedDiff = { text: string; rules: SecretRule[] };

const AWS_KEY = new RegExp(AWS_KEY_ID.source, "g");
const SECRET_VALUE = new RegExp(SECRET_ASSIGNMENT.source, "gi");

const marker = (rule: SecretRule): string => `[REDACTED:${rule}]`;

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const isEnvFile = (path: string): boolean => {
	const name = baseName(path);
	return ENV_FILE.test(name) && !EXAMPLE_FILE.test(name);
};

type Scan = { path: string; inKey: boolean; rules: Set<SecretRule> };

const redactContent = (content: string, state: Scan): string => {
	if (isEnvFile(state.path)) {
		state.rules.add("env_file");
		return marker("env_file");
	}
	if (state.inKey) {
		if (PRIVATE_KEY_END.test(content)) state.inKey = false;
		return marker("private_key");
	}
	if (PRIVATE_KEY_BEGIN.test(content)) {
		state.rules.add("private_key");
		state.inKey = !PRIVATE_KEY_END.test(content);
		return marker("private_key");
	}
	let out = content;
	if (AWS_KEY.test(out)) {
		state.rules.add("aws_access_key_id");
		out = out.replace(AWS_KEY, marker("aws_access_key_id"));
	}
	AWS_KEY.lastIndex = 0;
	if (SECRET_VALUE.test(out)) {
		state.rules.add("secret_assignment");
		SECRET_VALUE.lastIndex = 0;
		out = out.replace(
			SECRET_VALUE,
			(match) => `${match.slice(0, match.search(/['"]/) + 1)}${marker("secret_assignment")}`,
		);
	}
	SECRET_VALUE.lastIndex = 0;
	return out;
};

const FILE_HEADER = /^\+\+\+ (?:b\/(.*)|\/dev\/null)$/;

export const redactDiff = (diff: string): RedactedDiff => {
	const state: Scan = { path: "", inKey: false, rules: new Set() };
	const lines = diff.split("\n").map((line) => {
		const header = FILE_HEADER.exec(line);
		if (header) {
			state.path = header[1] ?? "";
			state.inKey = false;
			return line;
		}
		if (line.startsWith("+") && !line.startsWith("+++ ")) {
			return `+${redactContent(line.slice(1), state)}`;
		}
		return line;
	});
	return { text: lines.join("\n"), rules: [...state.rules] };
};
