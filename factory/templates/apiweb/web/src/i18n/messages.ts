export const messages = {
	"app.subtitle": "Base lista para construir.",
	"app.skip": "Saltar al contenido",
	"state.loading": "Cargando…",
	"state.retry": "Reintentar",
	"legal.nav": "Información legal",
	"legal.notice": "Aviso legal",
	"legal.privacy": "Política de privacidad",
	"legal.cookies": "Política de cookies",
} as const;

export type MessageKey = keyof typeof messages;
