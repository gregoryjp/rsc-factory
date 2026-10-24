# {{PRODUCT_NAME}} — guía para agentes

- Sitio estático (HTML + CSS). Node 22 (`.nvmrc`), `npm ci`.
- Verificación: `npm run check` (existe `index.html`, metadatos básicos y todos los enlaces locales resuelven).
- CSS con variables (tokens), mobile-first. Accesibilidad: semántica HTML, contraste, `alt` en imágenes.
- No modificar `scripts/check.mjs` para convertir un rojo en verde.
- Tests: `test/**/*.test.mjs` con `node:test` y `node:assert` (`npm test`); sin dependencias extra.
- `ui-routes.json` (raíz) lista las rutas que el motor captura con el navegador. Formato fijo: array JSON de rutas absolutas, por defecto `["/"]` (ejemplo con varias: `["/", "/contacto/"]`). No cambiar su formato.

## Seguridad, legal y diseño (reglas fijas)

- CSP: cada página lleva `<meta http-equiv="Content-Security-Policy">` estricta. Prohibido `<script>`/`<style>` en línea, atributos `onclick=`/`style=`, scripts o estilos de otros orígenes, recursos `http://` y `target="_blank"` sin `rel="noopener noreferrer"`. `npm run check` lo verifica. Cabeceras HTTP completas en `_headers` y `docs/operations/security-headers.md`.
- Legal: `legal/` contiene borradores provisionales (aviso legal, privacidad, cookies) enlazados desde el pie. Regla: no inventar datos legales; completar los marcadores `[PENDIENTE: ...]` con datos del PRD o dejarlos. El check avisa (WARN) mientras queden marcadores. No añadir banner de cookies salvo que se incorpore analítica o cookies no técnicas (ver `docs/operations/security-headers.md`).
- Diseño: colores, espaciado, tipografía fluida y radios salen de `tokens.css` (tema oscuro automático con `prefers-color-scheme`; contraste mínimo 4.5:1 en ambos temas, verificado por el check). Mantener `:focus-visible`, `prefers-reduced-motion`, enlace "Saltar al contenido" y zonas interactivas de al menos 24x24 px.
