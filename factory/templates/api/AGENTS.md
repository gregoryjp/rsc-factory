# {{PRODUCT_NAME}} — guía para agentes

- Producto solo API: workspace npm `api`. Node 22 (`.nvmrc`), versiones exactas, `npm ci`.
- Verificación: `npm run check` en la raíz (typecheck, lint, guards y tests del API).
- Sin comentarios en el código; las explicaciones van en `docs/`.
- API: vertical slices en `api/src/modules/<nombre>/` (routes → controller → service → repository). Un módulo solo se importa por su `index.ts`.
- Seguridad del API: toda ruta nueva bajo `/api/v1` exige `requireAuth` y se monta en `protectedMounts` de `src/composition.ts`; solo es pública si está en la allowlist explícita `PUBLIC_API_ROUTES`. Usar `requireRole` para roles y `assertOwned` para recursos de un usuario.
- No escribir autenticación propia (hash de contraseñas, tokens, sesiones, cookies): usar el módulo `auth`. No modificar los guards ni los middlewares de seguridad (`apiRouter`, `csrf`, `rateLimit`, `timeout`, helmet).
- Listados: todo endpoint que devuelve una colección usa `parsePageQuery`, `pageWindow`, `toPage` y `sendPage` (`src/infrastructure/pagination.ts`); máximo 100 por página y offset acotado. Un `findMany` sin `take` en un módulo rompe `npm run check:pagination`. Referencia: `GET /api/v1/audit/events`.
- POST inseguros que crean recursos o tienen efectos no repetibles: montar `idempotency.middleware` (`src/modules/idempotency`) en la ruta; el cliente envía `Idempotency-Key`. Misma clave y cuerpo devuelve la respuesta guardada; mismo key con otro cuerpo da 422. No usarlo en endpoints que devuelven tokens o cookies (auth).
- Auditoría: registrar acciones relevantes con el `AuditRecorder` (`audit.record`, inyectado desde `composition.ts`) con acción `dominio.accion`. Solo ids, recurso e IP; nunca emails, nombres, contraseñas ni contenido. `AuditEvent` es solo de inserción.
- Base de datos: el API usa `DATABASE_URL` (rol `app_runtime`, solo DML); las migraciones usan `MIGRATION_DATABASE_URL` (`npm run db:deploy`). Cada tabla nueva se concede ejecutando de nuevo `api/scripts/db/02-grants.sql`. No usar el superusuario en `DATABASE_URL`.
- Despliegue: `Dockerfile` (digest fijado, usuario no root, HEALTHCHECK, sin dependencias de desarrollo en la imagen final), `.dockerignore`, `docker-compose.prod.example.yml` y `.github/workflows/ci.yml` los vigila `npm run check:deploy`; no modificarlos para pasar un check. Runbooks en `docs/operations/` (`base-de-datos.md`, `backup-restore.md`, `despliegue.md`).
- No modificar scripts de guard, `biome.json`, `tsconfig*.json` ni la configuración de vitest para convertir un rojo en verde.
- Estado vivo del producto: `docs/STATE.md`. Arquitectura: `docs/ARCHITECTURE.md`. Estándares: `docs/STANDARDS.md`.
