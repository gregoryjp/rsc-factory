const channel = (value: number): number => {
	const unit = value / 255;
	return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
};

const luminance = (hex: string): number => {
	const digits = hex.replace("#", "");
	const [r = 0, g = 0, b = 0] = [0, 2, 4].map((i) =>
		channel(Number.parseInt(digits.slice(i, i + 2), 16)),
	);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

export const contrastRatio = (foreground: string, background: string): number => {
	const [high = 0, low = 0] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
	return (high + 0.05) / (low + 0.05);
};
