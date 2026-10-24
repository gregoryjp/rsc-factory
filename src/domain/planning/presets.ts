export type PresetId =
	| "backend-express-kimmbo"
	| "web-react-vite"
	| "static-landing"
	| "mobile-expo";

export type PresetEntry = {
	id: PresetId;
	docPath: string;
	appliesTo: string;
	conflictsWith: readonly PresetId[];
};

export const PRESETS: Record<PresetId, PresetEntry> = {
	"backend-express-kimmbo": {
		id: "backend-express-kimmbo",
		docPath: "factory/presets/backend-express-kimmbo.md",
		appliesTo: "Products with an API, persistence or authentication",
		conflictsWith: ["static-landing"],
	},
	"web-react-vite": {
		id: "web-react-vite",
		docPath: "factory/presets/web-react-vite.md",
		appliesTo: "Products with an interactive web UI",
		conflictsWith: ["static-landing"],
	},
	"static-landing": {
		id: "static-landing",
		docPath: "factory/presets/static-landing.md",
		appliesTo: "Static pages without API or database",
		conflictsWith: ["backend-express-kimmbo", "web-react-vite", "mobile-expo"],
	},
	"mobile-expo": {
		id: "mobile-expo",
		docPath: "factory/presets/mobile-expo.md",
		appliesTo: "Mobile apps with Expo and React Native, reviewed through the web export",
		conflictsWith: ["static-landing", "web-react-vite"],
	},
};

export const isPresetId = (value: string): value is PresetId => value in PRESETS;
