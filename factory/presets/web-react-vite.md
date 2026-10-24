# Preset — frontend web React + Vite

Fuente: docs/02-ARQUITECTURA-Y-PRD-FACTORY.md §9 y las convenciones de frontend de Gregory. Es la contraparte de `backend-express-kimmbo` en productos full-stack. Un PRD que especifique otra forma de trabajar lo reemplaza. Versiones exactas, sin `^`/`~`, resueltas con `npm view` al generar.

## Stack

React + Vite + TypeScript estricto, componentes funcionales y hooks, CSS Modules con tokens de diseño, Zustand solo para estado de cliente que lo justifique. Estado remoto separado del estado de UI. Pruebas con Vitest y Testing Library; Playwright para recorridos críticos.

## Estructura

Por feature: `src/features/<name>/{components,hooks,api,store,types}` con un `index.ts` como API pública. Componentes comunes solo cuando exista reutilización real. Rutas y guards en su propio módulo (`src/navigation/` o equivalente), nunca dispersos en `App.tsx`.

## Convenciones

1. Sin `class`, sin `React.FC`; props tipadas en la desestructuración.
2. Sin `fetch` dentro de componentes: capa de datos en funciones o hooks dedicados.
3. Estados de carga, vacío, error y reintento visibles en cada vista de datos.
4. Accesibilidad: navegación por teclado, foco visible, contraste, estado no comunicado solo por color.
5. Responsive: verificar al menos 390 px y 1440 px sin scroll horizontal injustificado.
6. Texto de usuario como texto (nunca HTML inyectado); si hay i18n, todo texto visible pasa por `t("key")`.
7. Selectors atómicos o `useShallow` en Zustand; nunca desestructurar el store completo.
