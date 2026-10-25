# Sistema de diseño de {{PRODUCT_NAME}}

Fuente única: `tokens.css` (variables CSS) y `styles.css` (base). No se escriben colores, espaciados ni tamaños sueltos en las páginas: se usan los tokens. `npm run check` valida contraste, tamaño mínimo de objetivo, foco visible y movimiento reducido.

## Tokens de color

Roles semánticos con tema oscuro automático (`prefers-color-scheme`). Contraste mínimo 4.5:1 en ambos temas para los pares texto/fondo que lista el check.

| Token | Uso |
|---|---|
| `--color-bg`, `--color-surface` | Fondo de página y de tarjetas/bloques |
| `--color-text`, `--color-muted` | Texto principal y secundario |
| `--color-link`, `--color-primary`, `--color-on-primary` | Enlaces, acción principal y texto sobre ella |
| `--color-border`, `--color-focus` | Separadores y anillo de foco |
| `--color-warning-bg`, `--color-warning-text` | Avisos (p. ej. el aviso de borrador legal) |

## Escala de espaciado

`--space-1` (0,25 rem), `--space-2` (0,5), `--space-3` (0,75), `--space-4` (1), `--space-6` (1,5), `--space-8` (2), `--space-12` (3). Espaciado entre bloques: `--space-8` o mayor; dentro de un componente: `--space-2` a `--space-4`.

## Escala tipográfica

Fluida con `clamp()`: `--step--1` (texto pequeño), `--step-0` (cuerpo), `--step-1`, `--step-2`, `--step-3` (título principal). `h1` usa `--step-3`, `h2` `--step-1` o `--step-2`. Medida de lectura: `--measure` (65ch). Una página tiene un solo `h1` y los niveles no se saltan (lo verifica el check).

## Radios y objetivos táctiles

`--radius-sm`, `--radius-md`, `--radius-lg`. `--target-min` (1,5 rem = 24 px) es el mínimo WCAG 2.2 (2.5.8) para enlaces y botones; en acciones principales conviene 44 px o más.

## Estados

- Foco: `:focus-visible` con `outline: 3px solid var(--color-focus)`. Prohibido `outline: none` sin una alternativa `:focus-visible` (lo verifica el check).
- Hover/activo: cambiar color o subrayado, nunca solo el color si es el único indicador.
- Deshabilitado: atributo `disabled`/`aria-disabled`, contraste del texto sin bajar de 3:1 y sin depender solo del color.
- Error y aviso: texto visible con rol (`role="alert"` para errores de formulario), color de aviso de los tokens y un icono o texto, no solo color.
- Movimiento: toda `transition`/`animation` queda neutralizada en `@media (prefers-reduced-motion: reduce)`.
- Imágenes: `width` y `height` explícitos, `loading="lazy"` salvo la imagen de la primera pantalla (`loading="eager"`), formatos `webp`/`avif`/`svg`; una imagen no pasa de 300 KiB.
- Fuentes: `@font-face` con `font-display: swap` y archivos del mismo origen.

## Presupuesto de rendimiento

`npm run check` falla si el JS suma más de 30 KiB o el CSS más de 60 KiB (sin comprimir), si una imagen supera 300 KiB o si un PNG/JPG supera 100 KiB (usar `webp`/`avif`).

## Textos y traducción

Los textos con `data-i18n="clave"` deben coincidir con `i18n/<lang>.json` (el idioma es el atributo `lang` de la página). La tabla es la fuente de las traducciones; el HTML sigue siendo estático. Para otro idioma: copiar la página con su `lang` y crear `i18n/<lang>.json`.
