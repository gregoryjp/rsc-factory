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
- Logs: pino escribe JSON por stdout con `req.id` en cada línea y redacta authorization, cookies, set-cookie, `x-api-key`, `x-csrf-token`, passwords, tokens, secretos y hashes (`REDACT_PATHS` en `src/infrastructure/logger.ts`, cubierto por `logger.test.ts`).

## Producción: base del API

- Paginación: `src/infrastructure/pagination.ts` valida con Zod `limit` (1 a 100, 20 por defecto) y `offset` (0 a 100000) y calcula `take: limit + 1` para saber si hay otra página sin hacer `count`. La respuesta es `{ data: [...], meta: { requestId, page: { limit, offset, hasMore } } }` (`sendPage`). `npm run check:pagination` falla si un `findMany` de un módulo no lleva `take`.
- Idempotencia (`src/modules/idempotency`): middleware opcional por ruta, detrás de `requireAuth`. Con el header `Idempotency-Key` (8 a 128 caracteres) reserva una fila `IdempotencyKey` única por `(userId, key)` con la huella SHA-256 de método, URL y cuerpo canónico. Misma huella con respuesta ya guardada: repite estado y cuerpo con `Idempotent-Replayed: true`. Otra huella: 422 `IDEMPOTENCY_KEY_REUSED`. Primera petición aún en curso: 409 `IDEMPOTENCY_IN_PROGRESS`. Una respuesta 5xx o una conexión cortada libera la clave para reintentar. TTL `IDEMPOTENCY_TTL_MS` (24 h) y purga horaria desde `server.ts`. La respuesta se guarda antes de enviarse. Ver `idempotency.e2e.test.ts` para el patrón de uso.
- Auditoría (`src/modules/audit`): tabla `AuditEvent` (quién `actorId`, `action`, `resource`, `ip`, `requestId`, `createdAt`) con un trigger que rechaza `UPDATE` y `DELETE`. `audit.record(evento)` devuelve un `Result` (`invalid_audit_event` o `audit_write_failed`) y nunca lanza: un fallo de auditoría se registra en el log pero no tumba la petición. Eventos de auth: `auth.register`, `auth.login`, `auth.login_failed`, `auth.refresh`, `auth.refresh_reuse_detected`, `auth.logout`. No se guardan emails ni contraseñas. `GET /api/v1/audit/events` lista los eventos del usuario autenticado, paginado.
- Ciclo de vida: `buildProduct` expone un `Lifecycle`; `createShutdown` (`src/infrastructure/shutdown.ts`) lo marca al recibir `SIGTERM`/`SIGINT`, con lo que `/health/ready` responde 503, drena las peticiones en curso hasta `SHUTDOWN_TIMEOUT_MS` y cierra Prisma. `configureServerTimeouts` fija `requestTimeout`, `headersTimeout` y `keepAliveTimeout`. `/health/live` no depende de la base; `/health/ready` sí.
- Datos y privilegios: dos roles (`app_runtime` solo DML, `app_migrator` dueño del esquema), `scripts/migrate.mjs` y los SQL de `api/scripts/db/`. Ver `docs/operations/base-de-datos.md`.
- Empaquetado: `Dockerfile` multi-stage, `.dockerignore`, `docker-compose.prod.example.yml`, `.github/workflows/ci.yml`, `scripts/db-backup.sh` y `scripts/db-restore.sh`. Ver `docs/operations/despliegue.md` y `docs/operations/backup-restore.md`. `npm run check:deploy` verifica lo comprobable de forma estática.
