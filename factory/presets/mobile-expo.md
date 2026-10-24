# Preset — app móvil Expo

Para productos móviles construidos con Expo y React Native. No se combina con `static-landing` ni con el preset web; la combinación con el backend aún no tiene plantilla, por lo que el repositorio contiene solo la app (sin backend).

## Alcance

App Expo (SDK 58) con React Native. La revisión visual se hace con la exportación web (`expo export --platform web`, React Native Web) capturada en 390 px y 1440 px. El comportamiento exclusivo de dispositivos nativos no se cubre en la revisión automática y requiere revisión manual.

## Convenciones

1. Versiones exactas, sin `^`/`~`; los paquetes `expo-*` y `react-native*` usan las versiones que Expo SDK 58 espera.
2. Estilos con `StyleSheet.create` y tokens de diseño en `src/theme/tokens.ts`; sin estilos inline sueltos.
3. Componentes funcionales con props tipadas en la desestructuración; nunca `React.FC`.
4. Pantallas en `src/screens`; lógica pura en `src/domain`, probada con vitest sin importar React Native.
5. Accesibilidad: `accessibilityRole` y `accessibilityLabel` en elementos interactivos.
6. Sin acceso a datos dentro de componentes: si se consume una API, se hace con funciones en `src/api/*`.
7. Verificación: `npm ci`, `npm run check` (typecheck + lint + tests) y `npm run build:web` para la revisión en navegador.
