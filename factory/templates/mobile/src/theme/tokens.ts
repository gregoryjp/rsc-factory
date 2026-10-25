export type ColorScheme = "light" | "dark";

export const lightColors = {
	background: "#f7f7fb",
	surface: "#ffffff",
	text: "#1b1b24",
	muted: "#55556a",
	primary: "#3b3bd6",
	onPrimary: "#ffffff",
} as const;

export const darkColors = {
	background: "#101018",
	surface: "#1a1a26",
	text: "#ececf4",
	muted: "#b4b4c8",
	primary: "#a8a8ff",
	onPrimary: "#0c0c18",
} as const;

export type Colors = typeof lightColors | typeof darkColors;

export const selectColors = (scheme: ColorScheme | null | undefined): Colors =>
	scheme === "dark" ? darkColors : lightColors;

export const spacing = {
	sm: 8,
	md: 16,
	lg: 24,
} as const;

export const radius = {
	md: 12,
} as const;

export const fontSize = {
	body: 16,
	title: 28,
} as const;

export const minTouchTarget = 48;
