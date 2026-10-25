# {{PRODUCT_NAME}} — guía para agentes

- Monorepo npm workspaces: `api`, `web`. Node 22 (`.nvmrc`), versiones exactas, `npm ci`.
- Verificación: `npm run check` en la raíz (typecheck, lint, guards, tests de ambos workspaces).
- Sin comentarios en el código; las explicaciones van en `docs/`.
- API: vertical slices en `api/src/modules/<nombre>/` (routes → controller → service → repository). Un módulo solo se importa por su `index.ts`.
- Seguridad del API: toda ruta nueva bajo `/api/v1` exige `requireAuth` y se monta en `protectedMounts` de `src/composition.ts`; solo es pública si está en la allowlist explícita `PUBLIC_API_ROUTES`. Usar `requireRole` para roles y `assertOwned` para recursos de un usuario.
- No escribir autenticación propia (hash de contraseñas, tokens, sesiones, cookies): usar el módulo `auth`. No modificar los guards ni los middlewares de seguridad (`apiRouter`, `csrf`, `rateLimit`, `timeout`, helmet).
- No modificar scripts de guard, `biome.json`, `tsconfig*.json` ni la configuración de vitest para convertir un rojo en verde.
- `web/ui-routes.json` lista las rutas que el motor captura con el navegador. Formato fijo: array JSON cuyas entradas son una ruta absoluta (`"/"`) o `{ "path": "/tickets", "as": "<rol>" }` para pantallas con login (roles y credenciales de prueba en `web/ui-auth.json`). Por defecto `["/"]`. No cambiar su formato.
- Estado vivo del producto: `docs/STATE.md`. Arquitectura: `docs/ARCHITECTURE.md`. Estándares: `docs/STANDARDS.md`.
