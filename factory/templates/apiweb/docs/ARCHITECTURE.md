# Arquitectura de {{PRODUCT_NAME}}

## Backend (`api`)

Flujo por módulo: routes → controller → service → repository → Prisma. `createApp` no tiene efectos secundarios; la composición vive en `src/composition.ts` y `src/server.ts` arranca el proceso.

Orden de middleware: requestId → pino-http → helmet → CORS (lista de orígenes) → `express.json({ limit: "100kb" })` → rutas → 404 → manejador de errores.

Envelopes: éxito `{ data, meta: { requestId } }`; error `{ error: { code, message, details?, requestId } }`.

## Frontend (`web`)

React + Vite + TypeScript estricto, CSS Modules. Estructura por feature cuando aparezcan funcionalidades.

Llamadas al api: siempre con URLs relativas `/api/...` (el prefijo `/api` se elimina antes de llegar al api: `/api/health/ready` llega como `/health/ready`). En desarrollo lo resuelve el proxy de `web/vite.config.ts`; en la vista previa del motor, su servidor estático. Pantallas con login: declarar `web/ui-auth.json` y rutas `{ "path": "...", "as": "<rol>" }` en `web/ui-routes.json` (credenciales solo de prueba, las mismas que crea la semilla de pruebas).

## Datos

PostgreSQL con Prisma. Las migraciones viven en `api/prisma/migrations`.

## Seguridad base del API

Orden de middleware: requestId → timeout → pino-http → helmet (CSP `default-src 'none'; frame-ancestors 'none'`, `no-referrer`, HSTS solo en producción) → CORS (con credenciales) → rate limit global → parsers JSON (10kb en `/api/v1/auth`, 100kb en el resto) → rutas → 404 → errores.

- Autenticación (`src/modules/auth`): contraseñas con argon2id (`@node-rs/argon2`), mínimo 12 y máximo 128 caracteres, email normalizado a minúsculas. Tokens opacos aleatorios guardados solo como SHA-256 en la tabla `Session`. Access token de 15 min en `Authorization: Bearer`; refresh token de 14 días en cookie HttpOnly, SameSite=Strict y Secure en producción, rotado en cada refresh. Reusar un refresh ya rotado revoca toda la familia de sesiones. El login hace una verificación con hash falso cuando el usuario no existe y devuelve siempre el mismo error genérico.
- Autorización por defecto denegada: `composeApiRouter` (`src/infrastructure/http/apiRouter.ts`) monta las rutas públicas y luego `requireAuth` para todo lo demás bajo `/api/v1`. Las rutas públicas deben estar en `PUBLIC_API_ROUTES` (`src/composition.ts`); si un router público expone una ruta no listada, o la lista tiene una entrada que no existe, el arranque falla. Los routers deben ser planos (sin routers anidados) para poder enumerarse. `requireRole(...)` restringe por rol y `assertOwned(recurso, auth)` responde 404 uniforme tanto si el recurso no existe como si es de otro usuario (anti-enumeración). Los módulos nuevos se agregan a `protectedMounts` en `composition.ts`.
- Rate limiting: `express-rate-limit` con límite global (`RATE_LIMIT_MAX` por `RATE_LIMIT_WINDOW_MS`, sin contar `/health`) y uno mucho más estricto (`RATE_LIMIT_AUTH_MAX`) en register, login y refresh. El almacén por defecto es en memoria (una sola instancia). Para varias instancias hay que inyectar un store compartido, por ejemplo Redis con `rate-limit-redis`, mediante `createStore` en `RateLimitConfig`. La IP sale de `req.ip`; `TRUST_PROXY=false` por defecto ignora `X-Forwarded-For` para que no se pueda falsificar. Detrás de un proxy de confianza, configurar el número de saltos (`TRUST_PROXY=1`); `true` se rechaza a propósito. En producción `superRefine` exige valores razonables.
- CSRF: el access token viaja por Bearer, así que solo `refresh` y `logout` usan cookie. Esos dos endpoints exigen el header `X-Requested-With: factory` (un formulario o una petición cross-site simple no puede enviarlo sin preflight CORS) y que `Origin`, si viene, esté en `CORS_ORIGINS`. Faltante o ajeno responde 403.
- Timeout: `REQUEST_TIMEOUT_MS` (30 s por defecto) responde 503 `REQUEST_TIMEOUT` con el envelope de error.
- Logs: pino redacta authorization, cookies, set-cookie, passwords y tokens.
