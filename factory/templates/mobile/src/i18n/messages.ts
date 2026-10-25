export const messages = {
	"home.start": "Comenzar",
	"home.greetingTarget": "equipo",
} as const;

export type MessageKey = keyof typeof messages;
