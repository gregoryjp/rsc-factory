import { type Failure, fail, ok, type Result } from "../../shared/result.js";

export type PlaceholderValues = { productName: string; productSlug: string };

const MAX_NAME_LENGTH = 60;
const MAX_SLUG_LENGTH = 40;
const DEFAULT_NAME = "Product";
const DEFAULT_SLUG = "product";

export const renderPlaceholders = (content: string, values: PlaceholderValues): string => {
	const replacements: Record<string, string> = {
		PRODUCT_NAME: values.productName,
		PRODUCT_SLUG: values.productSlug,
	};
	return content.replace(/\{\{(PRODUCT_NAME|PRODUCT_SLUG)\}\}/g, (_, key: string) => {
		return replacements[key] ?? "";
	});
};

export const toProductName = (raw: string): string => {
	const cleaned = raw
		.replace(/\s/g, " ")
		.replace(/[^\p{L}\p{N} ._-]/gu, "")
		.replace(/ +/g, " ")
		.trim()
		.slice(0, MAX_NAME_LENGTH)
		.trim();
	return cleaned === "" ? DEFAULT_NAME : cleaned;
};

export const toProductSlug = (name: string): string => {
	const base = name
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	if (base === "") return DEFAULT_SLUG;
	const prefixed = /^[0-9]/.test(base) ? `p_${base}` : base;
	return prefixed.slice(0, MAX_SLUG_LENGTH).replace(/_+$/, "");
};

const TEMPLATE_BY_PRESETS: Readonly<Record<string, string>> = {
	"backend-express-kimmbo+web-react-vite": "fullstack-kimmbo",
	"static-landing": "static-landing",
};

export const selectTemplateId = (
	presetIds: readonly string[],
): Result<string, Failure<"no_template_for_presets">> => {
	const key = [...new Set(presetIds)].sort().join("+");
	const id = TEMPLATE_BY_PRESETS[key];
	return id === undefined
		? fail("no_template_for_presets", `No product template for presets: ${key || "(none)"}`)
		: ok(id);
};
