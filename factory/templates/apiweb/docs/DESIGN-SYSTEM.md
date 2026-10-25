# Sistema de diseño de {{PRODUCT_NAME}} (web)

Fuente única: `web/public/tokens.css` (variables CSS, idéntico al de la landing) y `web/public/base.css`. Los componentes usan CSS Modules y los tokens; sin estilos inline ni valores mágicos. `npm run check -w web` valida contraste, foco visible, movimiento reducido, etiquetas de formulario y el presupuesto de la compilación.

## Tokens de color

Roles semánticos con tema oscuro automático: `--color-bg`, `--color-surface`, `--color-text`, `--color-muted`, `--color-link`, `--color-primary`, `--color-on-primary`, `--color-border`, `--color-focus`, `--color-warning-bg`, `--color-warning-text`. Contraste mínimo 4.5:1 en ambos temas.

## Escala de espaciado

`--space-1` a `--space-12` (0,25 rem a 3 rem). Dentro de un componente `--space-2` a `--space-4`; entre secciones `--space-8` o más.

## Escala tipográfica

Fluida: `--step--1`, `--step-0` (cuerpo), `--step-1`, `--step-2`, `--step-3`. Un solo `h1` por pantalla; los niveles no se saltan. Radios `--radius-sm|md|lg`; objetivo táctil mínimo `--target-min` (24 px, WCAG 2.2).

## Estados

Los componentes de estado ya existen en `web/src/components`: `Loading` (`role="status"`), `EmptyState` (sección con título) y `ErrorState` (`role="alert"` con botón de reintento). Reglas comunes:

- Foco: `:focus-visible` con el anillo de `--color-focus`; nunca `outline: none` sin alternativa.
- Cargando: mostrar `Loading`, no dejar la pantalla en blanco; conservar el contenido previo cuando se revalida.
- Vacío: `EmptyState` con una acción clara.
- Error: `ErrorState` con mensaje comprensible (sin trazas ni datos internos) y reintento.
- Deshabilitado: `disabled` real, no solo apariencia; nunca solo color.
- Formularios: cada control con `<label htmlFor>` (o envuelto en `<label>`, o `aria-label`); el check falla si falta.
- Movimiento: `transition`/`animation` siempre neutralizadas en `prefers-reduced-motion: reduce`.

## Textos

Todo texto visible sale de `src/i18n/messages.ts` con `t("clave")`. Las claves están tipadas (`MessageKey`): una clave inexistente no compila. Nuevo idioma: añadir otra tabla y elegirla en `t.ts` según el idioma; no se incorpora una librería de i18n hasta que el producto lo necesite.

## Presupuesto de rendimiento

El check (tras `build`) falla si el JS compilado suma más de 200 KiB o el CSS más de 40 KiB comprimidos con gzip, si una imagen pesa más de 300 KiB o un PNG/JPG más de 100 KiB. Lazy loading: cargar rutas pesadas con `React.lazy` + `Suspense` (mostrando `Loading`) y las imágenes con `loading="lazy"`.
