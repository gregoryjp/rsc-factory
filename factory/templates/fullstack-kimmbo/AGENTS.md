# {{PRODUCT_NAME}} — guía para agentes

- Monorepo npm workspaces: `api`, `web`. Node 22 (`.nvmrc`), versiones exactas, `npm ci`.
- Verificación: `npm run check` en la raíz (typecheck, lint, guards, tests de ambos workspaces).
- Sin comentarios en el código; las explicaciones van en `docs/`.
- API: vertical slices en `api/src/modules/<nombre>/` (routes → controller → service → repository). Un módulo solo se importa por su `index.ts`.
- No modificar scripts de guard, `biome.json`, `tsconfig*.json` ni la configuración de vitest para convertir un rojo en verde.
- Estado vivo del producto: `docs/STATE.md`. Arquitectura: `docs/ARCHITECTURE.md`. Estándares: `docs/STANDARDS.md`.
