# Arquitectura de {{PRODUCT_NAME}}

- `App.tsx`: raíz de la app; renderiza la pantalla inicial.
- `src/screens`: pantallas (componentes funcionales con props tipadas).
- `src/theme/tokens.ts`: tokens de diseño (colores, espaciado, radios, tipografía) consumidos con `StyleSheet.create`.
- `src/domain`: lógica pura, sin importar React Native, probada con vitest.
- `src/api`: funciones de acceso a datos, solo si el producto consume una API.

La revisión visual se hace sobre la exportación web (`npm run build:web`, React Native Web). El comportamiento exclusivo de dispositivos nativos requiere revisión manual.
