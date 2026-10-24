# Preset por defecto — backend Node/Express (referencia: kimmbo_API)

Fuente: inspección de solo lectura de `~/Projects/kimmbo_API` (2026-10-24). Es el preset por defecto para productos con backend. Un PRD que especifique otra forma de trabajar lo reemplaza (ver ADR 0002). No copiar código, datos, secretos ni decisiones de negocio de Kimmbo: solo convenciones.

## Stack (versiones probadas en kimmbo_API; re-verificar con `npm view` al generar)

ESM, Node ≥ 22 con `.nvmrc`, npm + lockfile (`npm ci`), Express 5.2.1, Prisma 6.19.3 + PostgreSQL, Zod 3.25.76, TypeScript 5.9.3, Vitest 5.0.2, supertest, Biome 2.5.14, pino + pino-http, helmet, cors, express-rate-limit (+ Redis store solo si el PRD lo requiere), argon2id. Versiones exactas, sin `^`/`~`.

## Anatomía de módulo (vertical slice)

```text
src/modules/<name>/
  routes/<x>.routes.ts          # composición de middleware + controller
  controllers/<x>.controller.ts # parse Zod, guards de req, sendData; sin Prisma
  services/<x>.service.ts       # reglas de negocio; sin Request/Response
  repositories/<x>.repository.ts# objeto plano sobre prisma; transacciones
  schemas/<x>.schemas.ts        # Zod + tipos inferidos
  types/<x>.types.ts
  middleware/                   # opcional: guards de recurso
  ports/                        # opcional: hooks para inversión entre módulos
  __tests__/                    # *.test.ts (unit) y *.e2e.test.ts (supertest)
  index.ts                      # única API pública del módulo
```

Flujo: routes → controller → service → repository → Prisma. Importar otro módulo solo vía su `index.ts`; dependencias inversas mediante `ports/` y `register*Hook`.

## Resto de la estructura

`src/config/env.ts` (Zod, fail-fast, `superRefine` para reglas de producción, singleton `env`), `src/infrastructure/{errors,logger,database,requestId}.ts`, `src/infrastructure/http/{app,respond}.ts`, `src/infrastructure/middleware/`, `src/shared/{http,security}/`, `src/server.ts` (listen, jobs, shutdown ordenado).

## Convenciones

1. Estilo funcional: objetos planos, closures y factories (`createXController(service)`, `createApp(options)`); sin clases salvo `AppError`. Reloj inyectable.
2. Errores: `AppError(status, code, message, {details})` con factories nombradas y unión de códigos tipada; `errorHandler` global mapea AppError, ZodError → 400 `VALIDATION_ERROR`, JSON inválido, payload grande, Prisma not found → 404, resto → 500 genérico.
3. Envelopes: éxito `{ data, meta: { requestId } }`; error `{ error: { code, message, details?, requestId } }`.
4. `createApp()` sin efectos; orden de middleware: requestId → pino-http → helmet → CORS allowlist → `express.json({limit:"100kb"})` → rutas → 404 → errorHandler.
5. Rutas: `/health/live` y `/health/ready` sin versión; negocio bajo `/api/v1`.
6. Persistencia: singleton Prisma; `$transaction` interactiva; métodos con `tx` opcional; auditoría en la misma transacción cuando el PRD exija historial.
7. SQL crudo solo con tagged templates (script guard).
8. Autorización en capas: `requireAuth` → (tenant si aplica) → rol → guard de recurso. 403 uniforme anti-enumeración; filtrar toda consulta por tenant cuando exista.
9. Auth por defecto: tokens opacos hasheados en BD, access corto + refresh en cookie HttpOnly SameSite=Strict rotada con detección de reutilización. Simplificar si el PRD lo justifica (registrar ADR).
10. Listados: paginación en BD, orden con desempate, allowlist de filtros.
11. Sin comentarios en código (guard `check:comments`); explicaciones en docs/ADR.
12. Tests contra Postgres real aislado (guard que exige `NODE_ENV=test` y BD de test), truncado por test, `fixtures.ts`, builders «world», archivos en serie.
13. TS: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noUnusedLocals/Parameters`, NodeNext, imports con `.js`.
14. Biome: tabs, ancho 100, comillas dobles, punto y coma, trailing commas, `noExplicitAny: error`.

## Gate del producto

`npm run check` = typecheck && lint && check:boundaries && check:sql && check:comments && test. La factory añade un guard que kimmbo_API solo documenta: services sin import de Express y controllers sin import de Prisma.

## Documentación del producto

`AGENTS.md`, `docs/{STATE,PROJECT_MAP,ARCHITECTURE,TECH_STACK,STANDARDS}.md`, `docs/adr/`, `docs/specs/`, `docs/modules/<m>.md`. Requisitos trazados a IDs del PRD.

## Frontend

kimmbo_API no cubre frontend. Para web: React + Vite + TS, CSS Modules, Zustand solo para estado UI (doc 02 §9). Pendiente definir un preset de referencia equivalente si Gregory lo indica.
