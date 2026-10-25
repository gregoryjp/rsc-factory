# {{PRODUCT_NAME}} — guía para agentes

- Monorepo npm workspaces: `api`, `web`. Node 22 (`.nvmrc`), versiones exactas, `npm ci`.
- Verificación: `npm run check` en la raíz (typecheck, lint, guards, tests de ambos workspaces).
- Sin comentarios en el código; las explicaciones van en `docs/`.
- API: vertical slices en `api/src/modules/<nombre>/` (routes → controller → service → repository). Un módulo solo se importa por su `index.ts`.
- No modificar scripts de guard, `biome.json`, `tsconfig*.json` ni la configuración de vitest para convertir un rojo en verde.
- `web/ui-routes.json` lista las rutas que el motor captura con el navegador. Formato fijo: array JSON cuyas entradas son una ruta absoluta (`"/"`) o `{ "path": "/tickets", "as": "<rol>" }` para pantallas con login (roles y credenciales de prueba en `web/ui-auth.json`). Por defecto `["/"]`. No cambiar su formato.
- Estado vivo del producto: `docs/STATE.md`. Arquitectura: `docs/ARCHITECTURE.md`. Estándares: `docs/STANDARDS.md`.

## Web: seguridad, legal y diseño (reglas fijas)

- CSP: `web/index.html` y `web/public/legal/*.html` llevan `<meta http-equiv="Content-Security-Policy">` estricta (el servidor de desarrollo de Vite la quita; la compilación y el motor la conservan). Prohibido `<script>`/`<style>` en línea, handlers `onclick=` y la prop `style={...}` (solo CSS Modules), orígenes externos y `http://`. `connect-src 'self'`: las llamadas a la API van a `/api` (mismo origen). Cabeceras HTTP completas en `web/public/_headers` y `docs/operations/security-headers.md`. Lo verifica `npm run check:static -w web` (parte de `npm run check`).
- Legal: `web/public/legal/` contiene borradores provisionales enlazados desde el pie de `App.tsx`. Regla: no inventar datos legales; completar los marcadores `[PENDIENTE: ...]` con datos del PRD o dejarlos (el check avisa con WARN). Sin banner de cookies mientras no haya analítica ni cookies no técnicas.
- Diseño: usar los tokens de `web/public/tokens.css` (variables CSS; tema oscuro automático; contraste ≥ 4.5:1 verificado). Mantener `:focus-visible`, `prefers-reduced-motion`, enlace "Saltar al contenido" y objetivos de al menos 24x24 px.
- Estados compartidos: reutilizar `Loading`, `EmptyState` y `ErrorState` (con reintento) de `web/src/components`; no recrearlos por pantalla.
