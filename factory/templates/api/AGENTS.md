# {{PRODUCT_NAME}} — guía para agentes

- Producto solo API: workspace npm `api`. Node 22 (`.nvmrc`), versiones exactas, `npm ci`.
- Verificación: `npm run check` en la raíz (typecheck, lint, guards y tests del API).
- Sin comentarios en el código; las explicaciones van en `docs/`.
- API: vertical slices en `api/src/modules/<nombre>/` (routes → controller → service → repository). Un módulo solo se importa por su `index.ts`.
- No modificar scripts de guard, `biome.json`, `tsconfig*.json` ni la configuración de vitest para convertir un rojo en verde.
- Estado vivo del producto: `docs/STATE.md`. Arquitectura: `docs/ARCHITECTURE.md`. Estándares: `docs/STANDARDS.md`.
