export type ScanFile = { path: string; content: string };
export type SecretFinding = { file: string; line: number; rule: SecretRule };
export type SecretRule = "env_file" | "private_key" | "aws_access_key_id" | "secret_assignment";

type LineRule = { rule: SecretRule; pattern: RegExp; skipExamplePaths: boolean };

export const ENV_FILE = /^\.env(rc|\..+)?$/;
export const EXAMPLE_FILE = /(^|\.)example$/;
export const PRIVATE_KEY_BEGIN =
	/-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/;
export const PRIVATE_KEY_END =
	/-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/;
export const AWS_KEY_ID = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/;
export const SECRET_ASSIGNMENT = /(secret|password|token|api[_-]?key)\s*[:=]\s*['"][^'"]{12,}/i;
const EXAMPLE_PATH = /(^|\/)(tests?|__tests__|fixtures?|examples?)(\/|$)|\.(test|spec)\.[^/]+$/;

const LINE_RULES: readonly LineRule[] = [
	{
		rule: "private_key",
		pattern: PRIVATE_KEY_BEGIN,
		skipExamplePaths: false,
	},
	{ rule: "aws_access_key_id", pattern: AWS_KEY_ID, skipExamplePaths: false },
	{
		rule: "secret_assignment",
		pattern: SECRET_ASSIGNMENT,
		skipExamplePaths: true,
	},
];

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const isExample = (path: string): boolean =>
	EXAMPLE_FILE.test(baseName(path)) || EXAMPLE_PATH.test(path);

export const scanFiles = (files: readonly ScanFile[]): SecretFinding[] =>
	files.flatMap((file) => {
		const name = baseName(file.path);
		const envFinding: SecretFinding[] =
			ENV_FILE.test(name) && !EXAMPLE_FILE.test(name)
				? [{ file: file.path, line: 1, rule: "env_file" }]
				: [];
		const example = isExample(file.path);
		const lineFindings = file.content
			.split("\n")
			.flatMap((text, index) =>
				LINE_RULES.filter((r) => !(r.skipExamplePaths && example) && r.pattern.test(text)).map(
					(r): SecretFinding => ({ file: file.path, line: index + 1, rule: r.rule }),
				),
			);
		return [...envFinding, ...lineFindings];
	});
