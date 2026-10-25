# Sistema de diseño de {{PRODUCT_NAME}} (móvil)

Fuente única: `src/theme/tokens.ts`. Las pantallas usan `StyleSheet.create` con estos tokens y `useColors()`; sin colores ni tamaños sueltos. `src/theme/tokens.test.ts` verifica el contraste 4.5:1 en ambos temas.

## Tokens de color

`lightColors` y `darkColors` con los roles `background`, `surface`, `text`, `muted`, `primary`, `onPrimary`. El tema sigue al sistema (`userInterfaceStyle: automatic`); en pantallas se obtiene con `useColors()`, nunca importando una paleta fija.

## Escala de espaciado

`spacing`: `sm` (8), `md` (16), `lg` (24). Separación entre elementos de un grupo: `sm` o `md`; relleno de pantalla: `lg`. Radios: `radius.md` (12).

## Escala tipográfica

`fontSize`: `body` (16) y `title` (28). Los textos respetan el tamaño de fuente del sistema (no desactivar `allowFontScaling`). El título de pantalla lleva `accessibilityRole="header"`.

## Estados

- Área táctil: `minTouchTarget` (48) en todo elemento interactivo.
- Accesibilidad: `accessibilityRole` y `accessibilityLabel` en `Pressable`/`TouchableOpacity` (lo verifica `src/security/sourceRules.test.ts`).
- Presionado: cambiar fondo u opacidad con el estado `pressed` de `Pressable`; no depender solo del color.
- Deshabilitado: `disabled` más `accessibilityState={{ disabled: true }}`.
- Cargando y error: texto visible (`accessibilityLiveRegion="polite"` para avisos) y acción de reintento; nada de errores técnicos al usuario.
- Vacío: mensaje y una acción clara.
- Movimiento: respetar «reducir movimiento» del sistema (`AccessibilityInfo.isReduceMotionEnabled`) antes de animar.

## Textos

Todo texto visible sale de `src/i18n/messages.ts` con `t("clave")` (tabla tipada `MessageKey`). Sin librería de i18n hasta que el producto tenga más de un idioma.
