# Preset — landing estática

Fuente: docs/02-ARQUITECTURA-Y-PRD-FACTORY.md §9 («Landing estática: sin API/BD si no la necesita»). Para páginas informativas sin autenticación ni datos propios. No se combina con el backend ni con el preset web de aplicación.

## Alcance

HTML/CSS (y JavaScript mínimo) generado con un bundler estático o un generador de sitios; sin API, sin base de datos, sin sesión. Formularios solo hacia un servicio externo declarado en el PRD.

## Convenciones

1. Versiones exactas, sin `^`/`~`, resueltas al generar.
2. CSS Modules o CSS plano con variables (tokens); mobile-first.
3. Accesibilidad básica: semántica HTML, contraste, foco, `alt` en imágenes.
4. Rendimiento: imágenes dimensionadas y comprimidas; sin dependencias de runtime innecesarias.
5. Verificación: build reproducible (`npm ci`), validación de enlaces y revisión visual en 390 px y 1440 px.
