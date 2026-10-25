# Despliegue

## Imagen

El `Dockerfile` de la raíz es multi-stage y fija la imagen de Node por digest (la misma que usa la factory).

| Stage | Para qué |
|---|---|
| `build` | `npm ci`, `prisma generate` y `tsc`. Con dependencias de desarrollo; nunca es la imagen final. |
| `prod-deps` | `npm ci --omit=dev --ignore-scripts`. |
| `migrate` | Parte de `build`; ejecuta `node scripts/migrate.mjs deploy` como usuario `node`. Se usa como tarea puntual con `MIGRATION_DATABASE_URL`. |
| `runtime` (final) | Solo dependencias de producción, el cliente Prisma generado y `dist/`. Usuario `node` (no root), `HEALTHCHECK` contra `/health/live`, `CMD` en forma exec para que `SIGTERM` llegue a Node. |

No escribe en disco: funciona con `read_only: true` y `tmpfs: /tmp`.

```bash
docker build --target runtime -t factory-mi-producto-api:local .
docker build --target migrate -t factory-mi-producto-migrate:local .
```

`docker-compose.prod.example.yml` es un ejemplo (copiar y adaptar, no usar tal cual): API con `read_only`, `cap_drop: ALL`, `no-new-privileges`, límites de memoria y procesos, `init`, `stop_grace_period` mayor que `SHUTDOWN_TIMEOUT_MS`, tarea `migrate` bajo el perfil `migrate` y PostgreSQL con digest fijado. Los secretos van en `.env.production` y `.env.migrate` (ignorados por git), nunca en la imagen: `.dockerignore` excluye `.env*`.

## Health y readiness

- `/health/live`: el proceso responde. Es el `HEALTHCHECK` de la imagen; no toca la base.
- `/health/ready`: hace `SELECT 1` con un límite de 2 s y responde `503` si la base no contesta o si el proceso ya empezó a apagarse. El balanceador debe usar este endpoint para sacar la instancia del tráfico.

## Apagado ordenado

`SIGTERM`/`SIGINT` ejecutan `createShutdown`: marca el proceso como en apagado (readiness pasa a `503`), deja de aceptar conexiones, cierra las inactivas, espera a las peticiones en curso hasta `SHUTDOWN_TIMEOUT_MS` (10 s por defecto), cierra el resto a la fuerza si se agota, hace `prisma.$disconnect()` y sale con `0` (o `1` si hubo cierre forzado o error).

## Timeouts

`REQUEST_TIMEOUT_MS` responde `503 REQUEST_TIMEOUT` a nivel de aplicación. El servidor HTTP añade `requestTimeout` (= `REQUEST_TIMEOUT_MS` + 5 s), `headersTimeout` de 15 s y `keepAliveTimeout` de 5 s para limitar conexiones lentas (slowloris). Si hay un proxy delante, su keep-alive debe ser menor que 5 s.

## Logs

JSON por stdout con pino. Cada línea de petición lleva `req.id` (el `x-request-id` aceptado o generado, también devuelto en la respuesta y en el envelope). Se redactan `authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-csrf-token` y cualquier `password`, `passwordHash`, `token`, `secret`, `apiKey`, `accessToken`, `refreshToken` y sus hashes. Los errores no controlados se registran con el logger de la petición, así que incluyen su `req.id`.

## CI

`.github/workflows/ci.yml`: `npm ci`, typecheck, lint y `npm run check` (guards y tests con PostgreSQL de servicio); `npm audit --omit=dev`; y el build Docker de los targets `runtime` y `migrate`. Las acciones están fijadas por SHA de commit (`actions/checkout` v7.0.1 y `actions/setup-node` v7.1.0, verificados contra la API de GitHub el 2026-10-25). No usa secretos; las credenciales del PostgreSQL de CI son de usar y tirar. Renovar los SHA a mano (o con Dependabot) y re-verificar la etiqueta.

## Idempotencia y mantenimiento

Las filas de `IdempotencyKey` caducan a las 24 h (`IDEMPOTENCY_TTL_MS`). `server.ts` las purga cada hora con `idempotency.purgeExpired()`.
