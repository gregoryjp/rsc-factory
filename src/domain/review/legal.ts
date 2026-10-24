export const LEGAL_NOT_APPLICABLE_REASON = "no personal data processing detected";

export type LegalApplicability =
	| { applies: true; signals: string[] }
	| { applies: false; reason: string };

export type LegalInput = {
	templateId: string;
	changedFiles: readonly string[];
	diff: string;
	requirementsText: string;
};

type DiffSection = { path: string; added: string[] };

const PERSONAL_FIELDS = [
	"email",
	"name",
	"firstName",
	"first_name",
	"lastName",
	"last_name",
	"fullName",
	"full_name",
	"phone",
	"mobile",
	"address",
	"birth",
	"birthdate",
	"birth_date",
	"birthday",
	"dob",
	"dni",
	"nif",
	"passport",
	"ip",
	"ipAddress",
	"ip_address",
	"location",
	"lat",
	"lng",
	"latitude",
	"longitude",
	"avatar",
	"photo",
];

const fieldPattern = new RegExp(
	`(?<![A-Za-z0-9_])(?:${PERSONAL_FIELDS.join("|")})(?![A-Za-z0-9_])`,
	"i",
);
const PRISMA_FILE = /(^|\/)prisma\/(schema\.prisma|migrations\/.+)$/;
const TRACKING_CODE =
	/document\.cookie|localStorage|sessionStorage|gtag|googletagmanager|analytics|pixel|\bfbq\(/i;
const AUTH_PATH = /(^|[/._-])(auth|session|sessions|login|signup|register|jwt|passport)([/._-]|$)/i;
const FORM_FIELD = /<(?:input|form|textarea|TextInput)\b/;
const REQUIREMENT_TEXT =
	/personal data|datos personales|privacy|privacidad|rgpd|gdpr|consent|consentimiento|usuario registro|registro de usuario|user registration/i;
const DIFF_HEADER = /^diff --git a\/(.+) b\/(.+)$/;

export const parseDiffSections = (diff: string): DiffSection[] => {
	const sections: DiffSection[] = [];
	for (const line of diff.split("\n")) {
		const header = DIFF_HEADER.exec(line);
		if (header?.[2]) {
			sections.push({ path: header[2], added: [] });
			continue;
		}
		const current = sections.at(-1);
		if (current && line.startsWith("+") && !line.startsWith("+++")) {
			current.added.push(line.slice(1));
		}
	}
	return sections;
};

type SignalCheck = (input: LegalInput, sections: readonly DiffSection[]) => boolean;

const addedLines = (sections: readonly DiffSection[]): string[] =>
	sections.flatMap((section) => section.added);

const SIGNALS: Record<string, SignalCheck> = {
	prisma_personal_data: (_input, sections) =>
		sections.some(
			(section) =>
				PRISMA_FILE.test(section.path) && section.added.some((line) => fieldPattern.test(line)),
		),
	tracking_code: (_input, sections) =>
		addedLines(sections).some((line) => TRACKING_CODE.test(line)),
	auth_session_code: (input) => input.changedFiles.some((path) => AUTH_PATH.test(path)),
	personal_data_form: (_input, sections) =>
		addedLines(sections).some((line) => FORM_FIELD.test(line) && fieldPattern.test(line)),
	requirements_mention_personal_data: (input) => REQUIREMENT_TEXT.test(input.requirementsText),
};

export const legalApplicability = (input: LegalInput): LegalApplicability => {
	const sections = parseDiffSections(input.diff);
	const signals = Object.entries(SIGNALS).flatMap(([name, check]) =>
		check(input, sections) ? [name] : [],
	);
	return signals.length > 0
		? { applies: true, signals }
		: { applies: false, reason: LEGAL_NOT_APPLICABLE_REASON };
};
