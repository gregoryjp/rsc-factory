# Arquitectura de {{PRODUCT_NAME}}

- `App.tsx`: raíz de la app; renderiza la pantalla inicial.
- `src/screens`: pantallas (componentes funcionales con props tipadas).
- `src/theme/tokens.ts`: tokens de diseño (paletas clara y oscura con `selectColors`, espaciado, radios, tipografía); `useColors()` elige la paleta según `useColorScheme`.
- `src/storage`: almacenamiento seguro de tokens (`secureToken.ts` puro + `expoSecureBackend.ts` sobre `expo-secure-store`). Nunca `AsyncStorage` para tokens.
- `src/navigation`: `validateDeepLink.ts` (validador puro con allowlist) y `deepLinkPolicy.ts` (esquema, hosts y rutas permitidos).
- `src/net`: `secureFetch.ts`, cliente HTTP solo `https` con lista de hosts; único lugar donde se llama a `fetch`.
- `src/i18n`: tabla de mensajes tipada y `t(clave)`.
- `src/security`: tests que fallan si se rompen reglas de código (AsyncStorage con tokens, secretos en `EXPO_PUBLIC_*`).
- `src/domain`: lógica pura, sin importar React Native, probada con vitest.
- `src/api`: funciones de acceso a datos, solo si el producto consume una API.

La revisión visual se hace sobre la exportación web (`npm run build:web`, React Native Web). El comportamiento exclusivo de dispositivos nativos requiere revisión manual.

## Configuración pública

Las variables `EXPO_PUBLIC_*` se incrustan en el bundle: son públicas. No hay secretos en el cliente; cualquier secreto vive en el backend.
