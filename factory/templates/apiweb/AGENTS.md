# {{PRODUCT_NAME}} — guía para agentes

- Monorepo npm workspaces: `api`, `web`. Node 22 (`.nvmrc`), versiones exactas, `npm ci`.
- Verificación: `npm run check` en la raíz (typecheck, lint, guards, tests de ambos workspaces).
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
- `web/ui-routes.json` lista las rutas que el motor captura con el navegador. Formato fijo: array JSON cuyas entradas son una ruta absoluta (`"/"`) o `{ "path": "/tickets", "as": "<rol>" }` para pantallas con login (roles y credenciales de prueba en `web/ui-auth.json`). Por defecto `["/"]`. No cambiar su formato.
- Estado vivo del producto: `docs/STATE.md`. Arquitectura: `docs/ARCHITECTURE.md`. Estándares: `docs/STANDARDS.md`.

## Web: seguridad, legal y diseño (reglas fijas)

- CSP: `web/index.html` y `web/public/legal/*.html` llevan `<meta http-equiv="Content-Security-Policy">` estricta (el servidor de desarrollo de Vite la quita; la compilación y el motor la conservan). Prohibido `<script>`/`<style>` en línea, handlers `onclick=` y la prop `style={...}` (solo CSS Modules), orígenes externos y `http://`. `connect-src 'self'`: las llamadas a la API van a `/api` (mismo origen). Cabeceras HTTP completas en `web/public/_headers` y `docs/operations/security-headers.md`. Lo verifica `npm run check:static -w web` (parte de `npm run check`).
- Legal: `web/public/legal/` contiene borradores provisionales enlazados desde el pie de `App.tsx`. Regla: no inventar datos legales; completar los marcadores `[PENDIENTE: ...]` con datos del PRD o dejarlos (el check avisa con WARN). Sin banner de cookies mientras no haya analítica ni cookies no técnicas.
- Diseño: usar los tokens de `web/public/tokens.css` (variables CSS; tema oscuro automático; contraste ≥ 4.5:1 verificado). Mantener `:focus-visible`, `prefers-reduced-motion`, enlace "Saltar al contenido" y objetivos de al menos 24x24 px.
- Estados compartidos: reutilizar `Loading`, `EmptyState` y `ErrorState` (con reintento) de `web/src/components`; no recrearlos por pantalla.
- Rendimiento y accesibilidad (verificado por `npm run check:static` tras el build): JS compilado ≤ 200 KiB y CSS ≤ 40 KiB con gzip; imágenes ≤ 300 KiB (PNG/JPG ≤ 100 KiB, preferir `webp`/`avif`); `@font-face` con `font-display` y del mismo origen; todo `input`/`select`/`textarea` con `<label htmlFor>`, `<label>` envolvente o `aria-label`; sin `tabindex` positivo ni `aria-hidden` en elementos enfocables; nunca `outline: none` sin `:focus-visible`. Cargar rutas pesadas con `React.lazy`.
- Textos: todo texto visible con `t("clave")` de `src/i18n` (tabla tipada, sin librería); añadir la clave a `messages.ts`. Sistema de diseño en `docs/DESIGN-SYSTEM.md`.
