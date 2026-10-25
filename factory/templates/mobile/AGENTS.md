# {{PRODUCT_NAME}} — guía para agentes

- App móvil Expo (SDK 58) con React Native y TypeScript estricto. Node 22 (`.nvmrc`), `npm ci`.
- Verificación: `npm run check` (typecheck + lint con Biome + tests). `npm run build:web` exporta la versión web que el motor revisa en el navegador.
- Estilos: `StyleSheet.create` con tokens de `src/theme/tokens.ts`; sin estilos inline sueltos ni valores mágicos de color/espaciado.
- Componentes funcionales con props tipadas en la desestructuración; nunca `React.FC`. Sin clases ni `this`.
- Pantallas en `src/screens`; lógica pura en `src/domain`. Sin acceso a datos dentro de componentes: si se consume una API, usar funciones en `src/api/*`.
- Accesibilidad: `accessibilityRole` y `accessibilityLabel` en todo elemento interactivo; áreas táctiles de al menos 48 px.
- Tests: `src/**/*.test.ts` con vitest (`npm test`), solo para lógica pura de `src/domain`; no importar `react-native` en los tests.
- `ui-routes.json` (raíz) lista las rutas que el motor captura con el navegador sobre la exportación web. Formato fijo: array JSON de rutas absolutas, por defecto `["/"]` (ejemplo con varias: `["/", "/ajustes"]`). No cambiar su formato.
- No modificar los scripts `check`, `typecheck`, `lint` ni las configuraciones (`biome.json`, `tsconfig.json`) para convertir un rojo en verde.
- Sin comentarios en el código.
- Tokens de sesión: solo con `src/storage/secureToken.ts` (`expo-secure-store`). Prohibido `AsyncStorage` para tokens, JWT, contraseñas o secretos (lo verifica `src/security/sourceRules.test.ts`).
- Configuración pública: todo `EXPO_PUBLIC_*` se incrusta en el bundle y es público. Nunca poner secretos, claves privadas ni API keys en variables `EXPO_PUBLIC_*` ni en el código; los secretos viven en el backend.
- Deep links: todo enlace entrante pasa por `validateDeepLink` con la política de `src/navigation/deepLinkPolicy.ts` (esquemas, hosts y rutas permitidos). Al añadir una pantalla enlazable, añadir su ruta a la política y un test.
- Tema: colores siempre vía `useColors()` (claro/oscuro automático, contraste ≥ 4.5:1 verificado en tests); no hardcodear colores en pantallas. Áreas táctiles ≥ 48 px (`minTouchTarget`).
