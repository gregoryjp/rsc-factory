export const formatGreeting = (name: string): string => {
	const trimmed = name.trim();
	return trimmed === "" ? "Hola" : `Hola, ${trimmed}`;
};
