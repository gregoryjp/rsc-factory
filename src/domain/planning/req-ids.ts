const DECLARATION = /^\s*(?:#{1,6}\s+|[-*+]\s+|\|\s*)?\**(REQ-\d{3,})\**\s*(?::|—|–|\||-\s)/;
const FENCE = /^\s*(?:```|~~~)/;
const TOKEN = /REQ-\d+/g;

const linesOutsideFences = (prd: string): string[] => {
	let inFence = false;
	return prd.split("\n").filter((line) => {
		if (FENCE.test(line)) {
			inFence = !inFence;
			return false;
		}
		return !inFence;
	});
};

export const extractDeclaredReqIds = (prd: string): string[] => {
	const ids = linesOutsideFences(prd).flatMap((line) => {
		const match = DECLARATION.exec(line);
		return match?.[1] === undefined ? [] : [match[1]];
	});
	return [...new Set(ids)];
};

export const findUnparsedReqTokens = (prd: string, declared: readonly string[]): string[] => {
	const tokens = prd.match(TOKEN) ?? [];
	return [...new Set(tokens)].filter((token) => !declared.includes(token));
};
