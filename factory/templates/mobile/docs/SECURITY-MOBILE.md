# Seguridad y privacidad móvil de {{PRODUCT_NAME}}

Lista de comprobación del equipo. Lo que dice «test» lo verifica `npm run check` (`src/security/sourceRules.test.ts` y los tests de cada módulo); el resto es revisión manual antes de publicar en las tiendas.

## Transporte

- Toda llamada de red pasa por `createSecureFetch` (`src/net/secureFetch.ts`): solo `https`, host dentro de `allowedHosts`, y rechazo de una respuesta redirigida a `http` o a otro host (`insecure_redirect`). Devuelve un resultado (`ok`/`error`), no lanza. (test: nadie más llama a `fetch`.)
- Cleartext solo en desarrollo contra `localhost`, `127.0.0.1` o `10.0.2.2` y solo si la política declara `allowLocalCleartext: true`. En producción la política no lo declara. (test: no hay URLs `http://` en el código.)
- No activar `NSAllowsArbitraryLoads` (iOS) ni `usesCleartextTraffic` (Android). (test sobre `app.json`.)
- Fijación de certificados (pinning): no está incluida. Exige un módulo nativo o una configuración de build propia y, si se hace mal, deja a los usuarios sin conexión al rotar el certificado. Valorarla solo si el modelo de amenazas lo pide y con un plan de rotación.
- Dispositivos con jailbreak o root: la app no los detecta ni se comporta distinto. La defensa es no confiar en el cliente: autorización y validación siempre en el servidor, y ningún secreto en el dispositivo.

## Secretos y almacenamiento

- Tokens de sesión solo en `src/storage/secureToken.ts` (`expo-secure-store`, Keychain/Keystore). Prohibido `AsyncStorage` para tokens. (test)
- `EXPO_PUBLIC_*` se incrusta en el bundle y es público: nada de secretos ni claves privadas ahí ni en `extra` de `app.json`. (test)
- Bloqueo biométrico opcional sin dependencias nuevas: `createExpoSecureBackend(true)` (`src/storage/expoSecureBackend.ts`) pasa `requireAuthentication` a `expo-secure-store`, y el sistema pide biometría o código al leer el valor. Usarlo solo para el token de sesión de alto riesgo, ofrecer una alternativa si el dispositivo no tiene biometría y recordar que cambiar la biometría registrada puede invalidar el valor guardado (el usuario vuelve a iniciar sesión). El valor por defecto es `false`.

## Pantalla y portapapeles

- Capturas y grabación de pantalla: React Native no trae control propio. Para pantallas sensibles (datos de salud, financieros, credenciales) hay que añadir `expo-screen-capture` (`usePreventScreenCapture`) tras decidirlo con el responsable; verificar su versión con `npm view` y fijarla exacta. También ocultar el contenido en el selector de apps si el producto lo exige.
- Portapapeles: no copiar tokens, contraseñas ni datos personales; no leer el portapapeles sin una acción explícita del usuario. (test: ningún archivo con valores tipo token usa un módulo de portapapeles.)
- No registrar en logs tokens, cabeceras `Authorization` ni datos personales.

## Permisos y privacidad

- Pedir el mínimo: `app.json` no declara permisos de Android ni textos `NS…UsageDescription` de iOS hasta que una funcionalidad los necesite. Cada permiso nuevo exige: la funcionalidad que lo justifica, pedirlo en el momento de uso (no al arrancar), una explicación previa al usuario y que la app funcione si lo deniega. (test: la lista permitida está vacía; ampliarla es una decisión explícita en `ALLOWED_ANDROID_PERMISSIONS`.)
- Manifiesto de privacidad de iOS (`PrivacyInfo.xcprivacy`) y declaración de seguridad de datos de Google Play: antes de publicar, inventariar los datos que recoge la app y las librerías (Expo y sus módulos pueden declarar APIs de «razón requerida»), completar `ios.privacyManifests` en `app.json` según la documentación de Expo y de Apple vigente, y rellenar los formularios de las tiendas. Esto no se puede inferir del código: lo completa una persona con el PRD delante.
- Datos personales: aplicar el mismo inventario que el backend (qué se guarda, dónde, cuánto tiempo, cómo se borra). Política de privacidad enlazada desde la app y desde la ficha de la tienda.
- Deep links: todo enlace entrante pasa por `validateDeepLink`. (test)

## Accesibilidad

- `accessibilityRole` y `accessibilityLabel` en cada `Pressable`/`Touchable*`. (test)
- Áreas táctiles de 48 px (`minTouchTarget`), contraste 4.5:1 en los dos temas (test de tokens), tamaño de fuente del sistema respetado.
