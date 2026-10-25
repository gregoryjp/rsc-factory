# Cabeceras de seguridad

El alojamiento estático no siempre permite fijar cabeceras HTTP. Por eso hay dos capas:

1. **`<meta http-equiv="Content-Security-Policy">`** en cada página (siempre activa). Política: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none'`.
2. **Cabeceras HTTP reales** (recomendado): `_headers` (Netlify, Cloudflare Pages) o `docs/operations/Caddyfile.snippet` (Caddy).

## Limitaciones del `<meta>`

- `frame-ancestors`, `report-uri` y `sandbox` **no se aplican desde `<meta>`**: el navegador los ignora. Solo funcionan como cabecera HTTP, por eso `_headers` y el snippet de Caddy añaden `frame-ancestors 'none'` (anti-clickjacking).
- HSTS, `X-Content-Type-Options`, `Referrer-Policy` y `Permissions-Policy` solo existen como cabeceras HTTP (el `<meta name="referrer">` cubre únicamente la política de referrer).

## Conjunto completo

| Cabecera | Valor |
|---|---|
| `Content-Security-Policy` | la política de arriba + `frame-ancestors 'none'` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` (solo con HTTPS ya operativo; añadir `preload` solo tras decidirlo) |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=(), usb=()` |

## Reglas para el código del sitio

- Sin `<script>` en línea, sin atributos `onclick=`/`style=`, sin `<style>` en línea: la CSP los bloquea. Todo JS y CSS va en archivos propios del mismo origen.
- Sin scripts ni estilos de otros orígenes (CDN). Si hace falta uno, se añade su origen concreto a la política y a `_headers` en el mismo cambio, con motivo documentado.
- Enlaces `target="_blank"` siempre con `rel="noopener noreferrer"`; sin recursos `http://`.
- `npm run check` falla si se incumple cualquiera de estas reglas.

## Cuándo hace falta un banner de cookies

Esta plantilla no usa cookies de seguimiento, por lo que no incluye banner. Pasa a ser necesario en cuanto se añada analítica, publicidad, píxeles de terceros o cualquier cookie no técnica: entonces hay que obtener consentimiento previo, actualizar `legal/politica-cookies.html` y revisar la CSP. Decisión del titular con asesoría jurídica.
