# ADR 0002 — Preset de producto por defecto basado en kimmbo_API

- Estado: aceptado
- Fecha: 2026-10-24
- Decide: Gregory

## Contexto

La factory necesita un preset por defecto para productos con backend. Gregory indicó que su forma de programar es la de `kimmbo_API` (vertical slices, TypeScript, Node, Express) y que se use como referencia salvo que el PRD indique otra cosa.

## Decisión

El preset por defecto es `factory/presets/backend-express-kimmbo.md`. El arquitecto de cada run lo aplica salvo que:

1. el PRD especifique stack, estructura o convenciones distintas → prevalece el PRD y se registra ADR en el producto;
2. el PRD no necesite backend (landing estática) → no se genera backend.

## Diferencias detectadas con otras guías de Gregory

- **Errores:** kimmbo_API usa excepciones (`AppError` + `errorHandler`), no Result pattern. Se sigue kimmbo_API por ser código real en producción. Cambiar a Result pattern requiere indicarlo en el PRD o un nuevo ADR.
- **Comentarios:** kimmbo_API prohíbe comentarios en código mediante guard. Se adopta.
- **Versiones:** Zod 3.25.76 y TypeScript 5.9.3 en kimmbo_API frente a Zod 4.6.7 / TS 7.0.2 `latest`. Los productos usan las versiones probadas de kimmbo_API; el motor de la factory decide las suyas en H1.

## Consecuencias

- El preset es convención, no código copiado: no se transfieren datos, secretos ni reglas de negocio de Kimmbo.
- La factory añade un guard de capas (services sin Express, controllers sin Prisma) que kimmbo_API solo documenta.
- Falta un preset de frontend de referencia.
