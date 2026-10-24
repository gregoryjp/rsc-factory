# {{PRODUCT_NAME}} — guía para agentes

- Sitio estático (HTML + CSS). Node 22 (`.nvmrc`), `npm ci`.
- Verificación: `npm run check` (existe `index.html`, metadatos básicos y todos los enlaces locales resuelven).
- CSS con variables (tokens), mobile-first. Accesibilidad: semántica HTML, contraste, `alt` en imágenes.
- No modificar `scripts/check.mjs` para convertir un rojo en verde.
- Tests: `test/**/*.test.mjs` con `node:test` y `node:assert` (`npm test`); sin dependencias extra.
- `ui-routes.json` (raíz) lista las rutas que el motor captura con el navegador. Formato fijo: array JSON de rutas absolutas, por defecto `["/"]` (ejemplo con varias: `["/", "/contacto/"]`). No cambiar su formato.
